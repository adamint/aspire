import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end proof that .NET Hot Reload applies to a project resource launched by the Aspire debug
 * adapter, using a REAL Aspire app, the REAL Aspire CLI, and a REAL C# Dev Kit installation.
 *
 * The decisive assertion is behavioral: an HTTP endpoint returns a new value after an edit is hot
 * reloaded, while the process id stays the same. An unchanged pid is what distinguishes an applied
 * delta from a silent restart.
 */
suite('Aspire Hot Reload end-to-end proof', function () {
    this.timeout(900000);

    const workspaceRoot = process.env.ASPIRE_HOT_RELOAD_PROOF_WORKSPACE ?? path.join(os.homedir(), 'aspire-hr-proof');
    const apiProgramPath = path.join(workspaceRoot, 'HotReloadProof.Api', 'Program.cs');
    const urlFile = path.join(workspaceRoot, 'url.txt');
    const appHostProject = path.join(workspaceRoot, 'HotReloadProof.AppHost', 'HotReloadProof.AppHost.csproj');

    const originalProgram = fs.readFileSync(apiProgramPath, 'utf8');

    suiteTeardown(async () => {
        fs.writeFileSync(apiProgramPath, originalProgram);
        await vscode.debug.stopDebugging();
    });

    async function waitFor<T>(description: string, produce: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
        const start = Date.now();
        let lastError: unknown;
        while (Date.now() - start < timeoutMs) {
            try {
                const value = await produce();
                if (value !== undefined) {
                    return value;
                }
            }
            catch (err) {
                lastError = err;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms${lastError ? ` (last error: ${lastError})` : ''}`);
    }

    async function get(baseUrl: string, route: string): Promise<string> {
        const response = await fetch(new URL(route, baseUrl));
        assert.ok(response.ok, `GET ${route} failed with ${response.status}`);
        return (await response.text()).trim();
    }

    test('an edit to a project resource is hot reloaded into the running process', async () => {
        fs.rmSync(urlFile, { force: true });

        const devKit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
        assert.ok(devKit, 'C# Dev Kit must be installed');
        await devKit.activate();
        console.log(`[proof] Dev Kit ${devKit.packageJSON.version}, limitedActivation=${devKit.exports?.isLimitedActivation}`);
        assert.notStrictEqual(devKit.exports?.isLimitedActivation, true, 'Dev Kit must not be in limited activation');

        const coreclrSessions: vscode.DebugSession[] = [];
        const disposables: vscode.Disposable[] = [];
        const stamp = () => new Date().toISOString().slice(11, 23);

        disposables.push(vscode.debug.onDidStartDebugSession(session => {
            console.log(`[proof ${stamp()}] session STARTED name='${session.name}' type='${session.type}' parent='${session.parentSession?.name ?? '<none>'}'`);
            if (session.type === 'coreclr') {
                coreclrSessions.push(session);
            }
        }));

        disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
            console.log(`[proof ${stamp()}] session TERMINATED name='${session.name}' type='${session.type}'`);
        }));

        // Trace every DAP message on both session types. This is the only way to see why a session
        // dies: vsdbg reports launch failures as 'output' events and normal exits as 'exited'.
        for (const debugType of ['aspire', 'coreclr']) {
            disposables.push(vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
                createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
                    const tag = `${session.type}/${session.name}`;
                    return {
                        onWillReceiveMessage: (m: any) => {
                            if (m.command && m.command !== 'threads') {
                                console.log(`[dap ${stamp()}] -> ${tag} ${m.command}`);
                            }
                        },
                        onDidSendMessage: (m: any) => {
                            if (m.type === 'event' && m.event === 'output') {
                                const text = String(m.body?.output ?? '').trimEnd();
                                if (text) {
                                    console.log(`[dap ${stamp()}] <- ${tag} output(${m.body?.category}): ${text}`);
                                }
                            }
                            else if (m.type === 'event' && m.event !== 'loadedSource' && m.event !== 'module' && m.event !== 'thread') {
                                console.log(`[dap ${stamp()}] <- ${tag} event ${m.event} ${JSON.stringify(m.body ?? {}).slice(0, 300)}`);
                            }
                            else if (m.type === 'response' && m.success === false) {
                                console.log(`[dap ${stamp()}] <- ${tag} FAILED ${m.command}: ${m.message}`);
                            }
                        },
                        onError: (e: Error) => console.log(`[dap ${stamp()}] !! ${tag} error: ${e.message}`),
                        onExit: (code?: number, signal?: string) => console.log(`[dap ${stamp()}] !! ${tag} adapter exit code=${code} signal=${signal}`)
                    };
                }
            }));
        }

        try {
            const folder = vscode.workspace.workspaceFolders?.[0];
            assert.ok(folder, 'a workspace folder is required');

            const started = await vscode.debug.startDebugging(folder, {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire proof',
                program: appHostProject
            });
            assert.ok(started, 'the Aspire debug session must start');

            const apiSession = await waitFor(
                'the api project coreclr debug session',
                () => coreclrSessions.find(session => !session.configuration.isApphost),
                420000);

            const pipeName = apiSession.configuration.brokeredServicePipeName;
            console.log(`[proof] api session config keys: ${Object.keys(apiSession.configuration).join(', ')}`);
            console.log(`[proof] brokeredServicePipeName present: ${typeof pipeName === 'string' && pipeName.length > 0}`);
            assert.strictEqual(typeof pipeName, 'string', 'the project session must carry a brokered service pipe name');

            const baseUrl = await waitFor(
                'the api to report its listening address',
                () => fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf8').split(',')[0].trim() || undefined : undefined,
                300000);
            console.log(`[proof] api listening at ${baseUrl}`);

            const before = await waitFor('the api to serve requests', async () => await get(baseUrl, '/'), 120000);
            const pidBefore = await get(baseUrl, '/pid');
            console.log(`[proof] before edit: body='${before}' pid=${pidBefore}`);
            assert.strictEqual(before, 'BEFORE-EDIT');

            const document = await vscode.workspace.openTextDocument(apiProgramPath);
            const editor = await vscode.window.showTextDocument(document);
            const edited = originalProgram.replace('BEFORE-EDIT', 'AFTER-EDIT');
            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), edited);
            });
            await document.save();
            console.log('[proof] edit saved, requesting hot reload');

            await vscode.commands.executeCommand('csdevkit.debug.hotReload');

            const after = await waitFor(
                'the hot reloaded response',
                async () => {
                    const body = await get(baseUrl, '/');
                    return body === 'AFTER-EDIT' ? body : undefined;
                },
                180000);

            const pidAfter = await get(baseUrl, '/pid');
            console.log(`[proof] after hot reload: body='${after}' pid=${pidAfter}`);

            assert.strictEqual(after, 'AFTER-EDIT', 'the running process must serve the edited response');
            assert.strictEqual(pidAfter, pidBefore, 'the process must NOT have restarted - an unchanged pid proves the delta was applied');
        }
        finally {
            disposables.forEach(d => d.dispose());
        }
    });
});

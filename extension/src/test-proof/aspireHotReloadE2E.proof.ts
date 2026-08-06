import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end proof that .NET Hot Reload applies to project resources launched by the Aspire debug
 * adapter, using a REAL Aspire app, the REAL Aspire CLI, and a REAL C# Dev Kit installation.
 *
 * The app runs THREE .NET project resources concurrently, because one resource does not demonstrate
 * that hot reload works in a real Aspire app. Aspire attaches a separate `coreclr` session per
 * project on top of the AppHost's own session, and a delta is emitted for the whole solution at
 * once, so the interesting question is whether every running project picks up its own change.
 *
 * The decisive assertion is behavioral, per resource: the HTTP endpoint returns that resource's new
 * value after the edit, while its process id stays the same. An unchanged pid is what distinguishes
 * an applied delta from a silent restart.
 */
suite('Aspire Hot Reload end-to-end proof', function () {
    this.timeout(900000);

    const workspaceRoot = process.env.ASPIRE_HOT_RELOAD_PROOF_WORKSPACE ?? path.join(os.homedir(), 'aspire-hr-proof');
    const appHostProject = path.join(workspaceRoot, 'HotReloadProof.AppHost', 'HotReloadProof.AppHost.csproj');
    const devKitBaselineSettleMs = Number(process.env.ASPIRE_HOT_RELOAD_PROOF_SETTLE_MS ?? '20000');

    interface ProofResource {
        /** Aspire resource name, which is also the suffix of the debug session name. */
        resourceName: string;
        projectDirectory: string;
        marker: string;
        programPath: string;
        /** Each project writes its listening address next to its own binary. */
        urlFile: string;
        originalProgram: string;
    }

    const resources: ProofResource[] = [
        { resourceName: 'api', projectDirectory: 'HotReloadProof.Api', marker: '1' },
        { resourceName: 'api2', projectDirectory: 'HotReloadProof.Api2', marker: '2' },
        { resourceName: 'api3', projectDirectory: 'HotReloadProof.Api3', marker: '3' }
    ].map(resource => {
        const programPath = path.join(workspaceRoot, resource.projectDirectory, 'Program.cs');
        return {
            ...resource,
            programPath,
            urlFile: path.join(workspaceRoot, resource.projectDirectory, 'bin', 'Debug', 'net10.0', 'url.txt'),
            originalProgram: fs.readFileSync(programPath, 'utf8')
        };
    });

    suiteTeardown(async () => {
        for (const resource of resources) {
            fs.writeFileSync(resource.programPath, resource.originalProgram);
        }

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

    test('edits to every .NET resource are hot reloaded into their running processes', async () => {
        for (const resource of resources) {
            fs.rmSync(resource.urlFile, { force: true });
        }

        const devKit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
        assert.ok(devKit, 'C# Dev Kit must be installed');
        await devKit.activate();
        console.log(`[proof] Dev Kit ${devKit.packageJSON.version}, limitedActivation=${devKit.exports?.isLimitedActivation}`);
        assert.notStrictEqual(devKit.exports?.isLimitedActivation, true, 'Dev Kit must not be in limited activation');

        const coreclrSessions: vscode.DebugSession[] = [];
        const disposables: vscode.Disposable[] = [];
        const stamp = () => new Date().toISOString().slice(11, 23);

        disposables.push(vscode.debug.onDidStartDebugSession(session => {
            console.log(`[proof ${stamp()}] session STARTED name='${session.name}' type='${session.type}'`);
            if (session.type === 'coreclr') {
                coreclrSessions.push(session);
            }
        }));

        disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
            console.log(`[proof ${stamp()}] session TERMINATED name='${session.name}' type='${session.type}'`);
        }));

        // Trace DAP output on both session types. This is the only way to see why a session dies:
        // vsdbg reports launch failures as 'output' events and normal exits as 'exited'.
        for (const debugType of ['aspire', 'coreclr']) {
            disposables.push(vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
                createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
                    const tag = `${session.type}/${session.name}`;
                    return {
                        onDidSendMessage: (m: any) => {
                            if (m.type === 'event' && m.event === 'output') {
                                const text = String(m.body?.output ?? '').trimEnd();
                                if (text) {
                                    console.log(`[dap ${stamp()}] <- ${tag} output(${m.body?.category}): ${text}`);
                                }
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

            // Open every file that will be edited BEFORE launching, and leave them open.
            //
            // This mirrors how the feature is actually used - you have the file open and then you
            // type in it - and it matters for correctness here. Roslyn only reads a document from
            // disk when it first needs it. If a file is opened and edited within the same instant,
            // the editor buffer can win the race and Roslyn ingests the already-modified text as its
            // Edit-and-Continue baseline. It then compares that against the checksum recorded in the
            // PDB, reports `Checksum differs for source file '...'`, and silently drops the project
            // from the edit session. Opening first removes the race entirely.
            for (const resource of resources) {
                const document = await vscode.workspace.openTextDocument(resource.programPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }

            const started = await vscode.debug.startDebugging(folder, {
                type: 'aspire',
                request: 'launch',
                name: 'Aspire proof',
                program: appHostProject
            });
            assert.ok(started, 'the Aspire debug session must start');

            // Every project resource must get its own coreclr session, separate from the AppHost's.
            const projectSessions = await waitFor(
                `${resources.length} project coreclr debug sessions`,
                () => {
                    const sessions = coreclrSessions.filter(session => !session.configuration.isApphost);
                    return sessions.length >= resources.length ? sessions : undefined;
                },
                420000);

            console.log(`[proof] project sessions: ${projectSessions.map(s => s.name).join(', ')}`);

            for (const session of projectSessions) {
                const pipeName = session.configuration.brokeredServicePipeName;
                const present = typeof pipeName === 'string' && pipeName.length > 0;
                console.log(`[proof] ${session.name}: brokeredServicePipeName present: ${present}`);
                assert.strictEqual(present, true, `${session.name} must carry a brokered service pipe name`);
            }

            const before = new Map<string, { baseUrl: string; pid: string }>();
            for (const resource of resources) {
                const baseUrl = await waitFor(
                    `${resource.resourceName} to report its listening address`,
                    () => fs.existsSync(resource.urlFile) ? fs.readFileSync(resource.urlFile, 'utf8').split(',')[0].trim() || undefined : undefined,
                    300000);

                const body = await waitFor(`${resource.resourceName} to serve requests`, async () => await get(baseUrl, '/'), 120000);
                const pid = await get(baseUrl, '/pid');
                console.log(`[proof] before edit: ${resource.resourceName} body='${body}' pid=${pid} url=${baseUrl}`);
                assert.strictEqual(body, `BEFORE-EDIT-${resource.marker}`);
                before.set(resource.resourceName, { baseUrl, pid });
            }

            // Distinct pids prove these are genuinely separate processes rather than one host.
            const pids = [...before.values()].map(entry => entry.pid);
            assert.strictEqual(new Set(pids).size, resources.length, 'each resource must be its own process');

            // Let Dev Kit finish establishing its Edit-and-Continue baseline before editing.
            //
            // Dev Kit captures the baseline documents for a project some seconds AFTER its debug
            // session starts. Edit inside that window and the project is dropped from the edit
            // session with `Checksum differs for source file '...'` followed by `No code changes
            // were found` - which looks like a hot reload failure but is a race in the harness, not
            // in the product. Three fast-starting resources reach this point about two seconds after
            // launch, far quicker than any human edit, so wait it out.
            //
            // Dev Kit exposes no readiness signal for this, so the settle is time based on purpose.
            console.log(`[proof] waiting ${devKitBaselineSettleMs}ms for the Dev Kit edit session baseline to settle`);
            await new Promise(resolve => setTimeout(resolve, devKitBaselineSettleMs));

            for (const resource of resources) {
                const document = await vscode.workspace.openTextDocument(resource.programPath);
                const editor = await vscode.window.showTextDocument(document, { preview: false });
                const edited = resource.originalProgram.replace(`BEFORE-EDIT-${resource.marker}`, `AFTER-EDIT-${resource.marker}`);
                await editor.edit(editBuilder => {
                    editBuilder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), edited);
                });
                await document.save();
                console.log(`[proof] edited ${resource.resourceName}`);
            }

            console.log('[proof] all edits saved, requesting hot reload');
            await vscode.commands.executeCommand('csdevkit.debug.hotReload');

            for (const resource of resources) {
                const baseline = before.get(resource.resourceName)!;
                const expected = `AFTER-EDIT-${resource.marker}`;

                const after = await waitFor(
                    `${resource.resourceName} to serve the hot reloaded response`,
                    async () => {
                        const body = await get(baseline.baseUrl, '/');
                        return body === expected ? body : undefined;
                    },
                    180000);

                const pidAfter = await get(baseline.baseUrl, '/pid');
                console.log(`[proof] after hot reload: ${resource.resourceName} body='${after}' pid=${pidAfter}`);

                assert.strictEqual(after, expected, `${resource.resourceName} must serve the edited response`);
                assert.strictEqual(pidAfter, baseline.pid, `${resource.resourceName} must NOT have restarted - an unchanged pid proves the delta was applied`);
            }
        }
        finally {
            disposables.forEach(d => d.dispose());
        }
    });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Proves that adding Hot Reload support did not degrade the experience for users who do NOT have
 * C# Dev Kit.
 *
 * Two configurations are covered, selected by `ASPIRE_HOT_RELOAD_PROOF_MODE`:
 *
 * - `csharp-only` — only `ms-dotnettools.csharp` installed. Every .NET resource must still launch
 *   AND still attach a `coreclr` debug session, exactly as before. No brokered service pipe is
 *   supplied, and nothing prompts.
 * - `no-extensions` — neither the C# extension nor Dev Kit. The extension advertises no `project`
 *   capability, so the AppHost runs the projects itself with no debug sessions at all. They must
 *   still start and serve traffic.
 *
 * The failure this guards against is a regression, so the assertions are about the resources
 * working, not about Hot Reload.
 */
suite('Aspire without C# Dev Kit', function () {
    this.timeout(900000);

    const workspaceRoot = process.env.ASPIRE_HOT_RELOAD_PROOF_WORKSPACE ?? path.join(os.homedir(), 'aspire-hr-proof');
    const appHostProject = path.join(workspaceRoot, 'HotReloadProof.AppHost', 'HotReloadProof.AppHost.csproj');
    const mode = process.env.ASPIRE_HOT_RELOAD_PROOF_MODE ?? 'csharp-only';

    const resources = [
        { resourceName: 'api', projectDirectory: 'HotReloadProof.Api', marker: '1' },
        { resourceName: 'api2', projectDirectory: 'HotReloadProof.Api2', marker: '2' },
        { resourceName: 'api3', projectDirectory: 'HotReloadProof.Api3', marker: '3' }
    ].map(resource => ({
        ...resource,
        urlFile: path.join(workspaceRoot, resource.projectDirectory, 'bin', 'Debug', 'net10.0', 'url.txt')
    }));

    suiteTeardown(async () => {
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

    test('every .NET resource still runs without C# Dev Kit', async () => {
        for (const resource of resources) {
            fs.rmSync(resource.urlFile, { force: true });
        }

        // Guard against proving nothing because the wrong extension set was loaded.
        assert.strictEqual(vscode.extensions.getExtension('ms-dotnettools.csdevkit'), undefined, 'C# Dev Kit must NOT be installed for this proof');
        const csharpInstalled = vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined;
        assert.strictEqual(csharpInstalled, mode === 'csharp-only', `mode '${mode}' does not match the installed extension set`);

        // The Hot Reload command is contributed by Dev Kit, so its absence confirms the toolbar
        // button genuinely cannot appear in this configuration.
        const commands = await vscode.commands.getCommands(true);
        assert.strictEqual(commands.includes('csdevkit.debug.hotReload'), false);

        const notifications: string[] = [];
        const originalShowInformationMessage = vscode.window.showInformationMessage;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string, ...rest: unknown[]) => {
            notifications.push(message);
            return (originalShowInformationMessage as (...args: unknown[]) => Thenable<unknown>)(message, ...rest);
        };

        const coreclrSessions: vscode.DebugSession[] = [];
        const disposables: vscode.Disposable[] = [];
        disposables.push(vscode.debug.onDidStartDebugSession(session => {
            console.log(`[proof] session STARTED name='${session.name}' type='${session.type}'`);
            if (session.type === 'coreclr') {
                coreclrSessions.push(session);
            }
        }));

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

            // Every resource has to come up and serve traffic. This is the regression that would
            // matter: if the Hot Reload work broke the launch path, resources would never listen.
            const pids: string[] = [];
            for (const resource of resources) {
                const baseUrl = await waitFor(
                    `${resource.resourceName} to report its listening address`,
                    () => fs.existsSync(resource.urlFile) ? fs.readFileSync(resource.urlFile, 'utf8').split(',')[0].trim() || undefined : undefined,
                    420000);

                const body = await waitFor(`${resource.resourceName} to serve requests`, async () => await get(baseUrl, '/'), 120000);
                const pid = await get(baseUrl, '/pid');
                console.log(`[proof] ${mode}: ${resource.resourceName} body='${body}' pid=${pid} url=${baseUrl}`);
                assert.strictEqual(body, `BEFORE-EDIT-${resource.marker}`);
                pids.push(pid);
            }

            assert.strictEqual(new Set(pids).size, resources.length, 'each resource must be its own process');

            if (mode === 'csharp-only') {
                // Debugging must be exactly as good as it was before: a coreclr session per project.
                const projectSessions = await waitFor(
                    `${resources.length} project coreclr debug sessions`,
                    () => {
                        const sessions = coreclrSessions.filter(session => !session.configuration.isApphost);
                        return sessions.length >= resources.length ? sessions : undefined;
                    },
                    120000);

                console.log(`[proof] csharp-only project sessions: ${projectSessions.map(s => s.name).join(', ')}`);

                for (const session of projectSessions) {
                    assert.strictEqual(
                        session.configuration.brokeredServicePipeName,
                        undefined,
                        `${session.name} must not carry a brokered service pipe without Dev Kit`);
                }
            }
            else {
                // Without the C# extension the extension advertises no 'project' capability, so the
                // AppHost runs the projects itself and no debug session is created for them. The
                // resources still have to run, which the assertions above already established.
                const projectSessions = coreclrSessions.filter(session => !session.configuration.isApphost);
                assert.strictEqual(projectSessions.length, 0, 'no coreclr sessions are expected without the C# extension');
            }

            const hotReloadNotifications = notifications.filter(message => message.includes('Hot Reload'));
            console.log(`[proof] notifications seen: ${JSON.stringify(notifications)}`);
            assert.deepStrictEqual(hotReloadNotifications, [], 'a user without Dev Kit must never be prompted about Hot Reload');
        }
        finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalShowInformationMessage;
            disposables.forEach(d => d.dispose());
        }
    });
});

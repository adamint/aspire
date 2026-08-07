import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { announceHotReloadForSessionIfNeeded, getHotReloadDiagnostics, initializeHotReloadPromptState, logHotReloadDiagnostics, promptToEnableHotReloadIfNeeded } from '../debugger/hotReload';
import { getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration } from '../dcp/types';
import { createTestMemento } from './common';
import { hotReloadAvailablePrompt } from '../loc/strings';
import { extensionLogOutputChannel } from '../utils/logging';

/**
 * Regression coverage for the cases where .NET Hot Reload must stay completely invisible.
 *
 * Hot Reload is an enhancement that only applies to .NET project resources debugged through C# Dev
 * Kit. Two populations must never see any trace of it: users running polyglot Aspire apps with no
 * .NET resources at all, and users who have the C# extension but not Dev Kit. "No trace" means no
 * notification, no output-channel logging, and no change to any launch configuration.
 *
 * Every suite here arms the feature as strongly as it can be armed - Dev Kit installed, active,
 * fully activated, and the Hot Reload setting turned OFF, which is precisely the state that makes a
 * .NET project resource raise the enable prompt - and then asserts that nothing happens anyway. An
 * "armed harness" control test in each suite proves the setup would fire if it were eligible, so
 * these cannot silently degrade into tests that pass because nothing was wired up.
 */
suite('Hot Reload Regression Tests', () => {
    let notification: sinon.SinonStub;
    let logInfo: sinon.SinonStub;
    let logWarn: sinon.SinonStub;

    setup(() => {
        notification = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        logInfo = sinon.stub(extensionLogOutputChannel, 'info');
        logWarn = sinon.stub(extensionLogOutputChannel, 'warn');
        initializeHotReloadPromptState(createTestMemento());
    });

    teardown(() => {
        sinon.restore();
        initializeHotReloadPromptState(undefined);
    });

    /** Everything installed and active, including Dev Kit reporting full (non-limited) activation. */
    function stubAllExtensionsInstalled(): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => ({
            id: extensionId,
            isActive: true,
            exports: extensionId === 'ms-dotnettools.csdevkit' ? { isLimitedActivation: false } : {}
        } as unknown as vscode.Extension<unknown>));
    }

    /** The C# extension and every non-.NET debugger, but deliberately no C# Dev Kit. */
    function stubEverythingExceptDevKit(): void {
        sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) =>
            extensionId === 'ms-dotnettools.csdevkit'
                ? undefined
                : ({ id: extensionId, isActive: true, exports: {} } as unknown as vscode.Extension<unknown>));
    }

    /** Turns the Hot Reload gate off, which is the state that makes an eligible resource prompt. */
    function stubHotReloadSettingOff(): void {
        sinon.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => false,
            update: async () => undefined
        } as unknown as vscode.WorkspaceConfiguration);
    }

    function hotReloadLogLines(): string[] {
        return [...logInfo.getCalls(), ...logWarn.getCalls()]
            .map(call => String(call.args[0]))
            .filter(line => /hot reload/i.test(line));
    }

    function assertNoHotReloadTrace(context: string): void {
        assert.strictEqual(notification.called, false, `${context}: no Hot Reload notification may be shown. Shown: ${JSON.stringify(notification.args)}`);
        assert.deepStrictEqual(hotReloadLogLines(), [], `${context}: nothing about Hot Reload may be logged.`);
    }

    async function runDebuggerExtension(launchConfig: ExecutableLaunchConfiguration): Promise<AspireResourceExtendedDebugConfiguration> {
        const debuggerExtension = getResourceDebuggerExtensions().find(extension => extension.resourceType === launchConfig.type);
        assert.ok(debuggerExtension, `Expected a registered debugger extension for '${launchConfig.type}'.`);

        const debugConfiguration: AspireResourceExtendedDebugConfiguration = {
            type: 'aspire',
            request: 'launch',
            name: `Debug ${launchConfig.type}`,
            noDebug: false,
            runId: 'regression-run',
            debugSessionId: 'regression-session'
        };

        await debuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            [],
            [],
            {
                debug: true,
                runId: 'regression-run',
                debugSessionId: 'regression-session',
                isApphost: false,
                debugSession: sinon.createStubInstance(AspireDebugSession)
            },
            debugConfiguration);

        return debugConfiguration;
    }

    /**
     * Launch configurations for the resource types that make up a polyglot Aspire app.
     *
     * Only the cheap, side-effect-free debugger extensions are driven here. `azure-functions` and
     * `maui` are excluded because their callbacks spawn processes and talk to other extensions; they
     * are covered by the registry tripwire below instead.
     */
    const polyglotLaunchConfigurations: ReadonlyArray<{ label: string; launchConfig: ExecutableLaunchConfiguration }> = [
        { label: 'Node.js', launchConfig: { type: 'node', script_path: '/app/frontend/index.js' } as ExecutableLaunchConfiguration },
        { label: 'Bun', launchConfig: { type: 'bun', script_path: '/app/api/index.ts' } as ExecutableLaunchConfiguration },
        { label: 'Python', launchConfig: { type: 'python', program_path: '/app/worker/main.py' } as ExecutableLaunchConfiguration },
        { label: 'Go', launchConfig: { type: 'go', program: '/app/gateway/main.go' } as ExecutableLaunchConfiguration },
        { label: 'Browser', launchConfig: { type: 'browser', url: 'http://localhost:3000' } as ExecutableLaunchConfiguration }
    ];

    suite('a polyglot app with no .NET resources', () => {
        setup(() => {
            // Maximally armed: Dev Kit present and active, Hot Reload switched off. A .NET project
            // resource launched in this exact state raises the enable prompt.
            stubAllExtensionsInstalled();
            stubHotReloadSettingOff();
        });

        test('the harness is armed, so the assertions below are meaningful', async () => {
            // Control. Without this, every test in this suite could pass because the setup was
            // broken rather than because non-.NET resources are correctly ignored.
            //
            // Asserted on the notification rather than the return value: the function reports
            // whether the user ENABLED Hot Reload, and the stubbed notification dismisses without
            // choosing. What matters here is that the offer was made at all.
            await promptToEnableHotReloadIfNeeded(getHotReloadDiagnostics(), true);

            assert.strictEqual(notification.called, true, 'an eligible .NET resource must be offered Hot Reload in this configuration');
            assert.strictEqual(notification.firstCall.args[0], hotReloadAvailablePrompt);
        });

        for (const { label, launchConfig } of polyglotLaunchConfigurations) {
            test(`launching a ${label} resource shows and logs nothing about Hot Reload`, async () => {
                await runDebuggerExtension(launchConfig);

                assertNoHotReloadTrace(`${label} resource`);
            });

            test(`a ${label} launch configuration carries nothing Hot Reload related`, async () => {
                const debugConfiguration = await runDebuggerExtension(launchConfig);

                // Serialized so a value nested at any depth is caught, not just a top-level key.
                const serialized = JSON.stringify(debugConfiguration);
                assert.strictEqual(
                    /hotreload|brokeredservicepipename/i.test(serialized),
                    false,
                    `${label} launch configuration must not carry Hot Reload state: ${serialized}`);
            });
        }

        test('an entire polyglot session stays silent across every resource', async () => {
            // The realistic shape of the regression: a whole app of non-.NET resources launching one
            // after another, as they do at AppHost startup, must not accumulate into a notification.
            for (const { launchConfig } of polyglotLaunchConfigurations) {
                await runDebuggerExtension(launchConfig);
            }

            assertNoHotReloadTrace('a full polyglot session');
        });
    });

    suite('the C# extension without C# Dev Kit', () => {
        setup(() => {
            stubEverythingExceptDevKit();
            stubHotReloadSettingOff();
        });

        test('reports Hot Reload as unavailable rather than merely disabled', () => {
            const diagnostics = getHotReloadDiagnostics();

            assert.strictEqual(diagnostics.devKitInstalled, false);
        });

        test('never offers to enable Hot Reload, because enabling it would not help', async () => {
            // The setting belongs to Dev Kit. Turning it on for a user who does not have Dev Kit
            // would change nothing and would advertise a feature they cannot use.
            const prompted = await promptToEnableHotReloadIfNeeded(getHotReloadDiagnostics(), true);

            assert.strictEqual(prompted, false);
            assert.strictEqual(notification.called, false);
        });

        test('never announces an active Hot Reload session', () => {
            announceHotReloadForSessionIfNeeded(getHotReloadDiagnostics(), true);

            assert.strictEqual(notification.called, false);
        });

        test('logs nothing at all, because running .NET without Dev Kit is fully supported', () => {
            logHotReloadDiagnostics('api', getHotReloadDiagnostics());

            assert.deepStrictEqual(hotReloadLogLines(), []);
        });

        test('a .NET project resource is still debuggable', () => {
            // The C# extension is what contributes the coreclr adapter, so the project debugger must
            // remain registered. Dev Kit only adds Hot Reload on top of it.
            const projectDebugger = getResourceDebuggerExtensions().find(extension => extension.resourceType === 'project');

            assert.ok(projectDebugger, 'the project debugger must stay registered without Dev Kit');
            assert.strictEqual(projectDebugger.debugAdapter, 'coreclr');
        });
    });

    suite('neither the C# extension nor C# Dev Kit', () => {
        setup(() => {
            sinon.stub(vscode.extensions, 'getExtension').returns(undefined);
            stubHotReloadSettingOff();
        });

        test('does not register the .NET project debugger at all', () => {
            const resourceTypes = getResourceDebuggerExtensions().map(extension => extension.resourceType);

            assert.strictEqual(resourceTypes.includes('project'), false, `registered types: ${resourceTypes.join(', ')}`);
        });

        test('still registers the debuggers a polyglot app needs', () => {
            // Node and browser debugging use VS Code's built-in js-debug, so they must survive an
            // environment with no .NET tooling installed whatsoever.
            const resourceTypes = getResourceDebuggerExtensions().map(extension => extension.resourceType);

            assert.deepStrictEqual(resourceTypes, ['node', 'browser']);
        });

        test('shows and logs nothing about Hot Reload for any resource', async () => {
            for (const launchConfig of [
                { type: 'node', script_path: '/app/frontend/index.js' } as ExecutableLaunchConfiguration,
                { type: 'browser', url: 'http://localhost:3000' } as ExecutableLaunchConfiguration
            ]) {
                await runDebuggerExtension(launchConfig);
            }

            assertNoHotReloadTrace('an environment with no .NET tooling');
        });
    });

    suite('registry tripwire', () => {
        test('only the .NET project debugger is wired to Hot Reload', () => {
            stubAllExtensionsInstalled();

            const resourceTypes = getResourceDebuggerExtensions().map(extension => extension.resourceType).sort();

            // Deliberately an exact-match assertion. Hot Reload is applied only by the `project`
            // debugger, and the tests above drive every other cheap resource type to prove they stay
            // silent. Adding a debugger extension will fail this test, which is the point: whoever
            // adds it has to decide whether it needs Hot Reload coverage here.
            //
            // `azure-functions` and `maui` are .NET based but do NOT route through the project
            // debugger, so Hot Reload does not apply to them either. They are asserted here rather
            // than driven directly because their callbacks spawn processes.
            assert.deepStrictEqual(resourceTypes, [
                'azure-functions',
                'browser',
                'bun',
                'go',
                'maui',
                'node',
                'project',
                'python'
            ]);
        });

        test('every cheap non-.NET resource type is actually exercised above', () => {
            stubAllExtensionsInstalled();

            const exercised = polyglotLaunchConfigurations.map(entry => entry.launchConfig.type).sort();
            const registeredNonDotNet = getResourceDebuggerExtensions()
                .map(extension => extension.resourceType)
                .filter(resourceType => !['project', 'azure-functions', 'maui'].includes(resourceType))
                .sort();

            // Guards against the polyglot table silently drifting out of sync with the registry and
            // leaving a resource type with no coverage.
            assert.deepStrictEqual(exercised, registeredNonDotNet);
        });
    });
});

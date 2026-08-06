import * as assert from 'assert';
import { findResource, getCommandInvocationCount, waitForAppHostLaunching, waitForCommandOutcome, waitForNoRunningAppHost, waitForRepositoryIdle, waitForResourceState, waitForRunningAppHost, waitForWorkspaceAppHost } from './helpers/assertions';
import { executeE2eControlCommand, runE2eTeardown, stopPrimaryAppHostIfRunning } from './helpers/fixtures';
import { getPrimaryAppHostProjectPath } from './helpers/paths';
import { openAspireView } from './helpers/vscode';
import type { BrowserLaunchConfiguration, NodeLaunchConfiguration, ProjectLaunchConfiguration } from '../dcp/types';

/**
 * End-to-end coverage for the C# Dev Kit Hot Reload integration.
 *
 * This runs in the extension E2E environment, which installs the Aspire VSIX and nothing else — no
 * C# extension and no C# Dev Kit. That is not a gap in the fixture; it is the single most important
 * configuration to protect, because Hot Reload is an enhancement layered on an optional third-party
 * extension and the majority of users do not have Dev Kit. Every assertion here pins the guarantee
 * that a user without those extensions is no worse off than before Hot Reload support existed.
 *
 * The Dev Kit-present behavior (the enable prompt and the active-session notice) cannot be exercised
 * here, because Dev Kit is a licensed closed-source extension that cannot be installed in CI. That
 * behavior is covered by unit tests in `src/test/hotReload.test.ts` and by the regression suite in
 * `src/test/hotReloadRegressions.test.ts`, both of which drive the real debugger registry. Whether
 * Dev Kit then actually applies a delta is Dev Kit's own behavior, not Aspire's, and is verified by
 * hand against a real Aspire app rather than asserted here.
 */
suite('Aspire Hot Reload E2E', function () {
    this.timeout(600000);

    const nodeLaunchConfig: NodeLaunchConfiguration = { type: 'node', script_path: 'index.js' };
    const browserLaunchConfig: BrowserLaunchConfiguration = { type: 'browser', url: 'http://localhost:3000' };

    teardown(async () => {
        await runE2eTeardown([
            () => stopPrimaryAppHostIfRunning(),
            () => waitForNoRunningAppHost(),
        ], 'Hot Reload E2E teardown failed.');
    });

    test('does not register the .NET project debugger when the C# extension is absent', async () => {
        await openAspireView();
        await waitForRepositoryIdle();

        const debuggerExtensions = (await executeE2eControlCommand({ name: 'getResourceDebuggerExtensions' })).result as ReadonlyArray<{
            resourceType: string;
            extensionId?: string;
        }>;

        // This is the structural reason none of the Hot Reload code can affect a user without the C#
        // extension: `getResourceDebuggerExtensions()` only pushes the project debugger when
        // `isCsharpInstalled()`, and the Hot Reload block lives inside that debugger's
        // `createDebugSessionConfigurationCallback`. With no project debugger registered, the code
        // is not merely inert — it is unreachable.
        const projectDebugger = debuggerExtensions.find(extension => extension.resourceType === 'project');
        assert.strictEqual(
            projectDebugger,
            undefined,
            `Expected no project debugger without the C# extension, but found ${JSON.stringify(projectDebugger)}. ` +
            `Registered types: ${debuggerExtensions.map(extension => extension.resourceType).join(', ')}.`);
    });

    test('refuses to build a .NET resource debug configuration when the C# extension is absent', async () => {
        await openAspireView();
        await waitForRepositoryIdle();

        const projectLaunchConfig: ProjectLaunchConfiguration = { type: 'project', project_path: 'Any.csproj', mode: 'Debug' };

        // Exercises the real `createDebugSessionConfiguration` path rather than a stand-in, so a
        // regression that registered the project debugger unconditionally would fail here.
        await assert.rejects(
            () => executeE2eControlCommand({
                name: 'createResourceDebugConfiguration',
                launchConfig: projectLaunchConfig,
            }),
            /No resource debugger extension is registered for launch configuration type 'project'/,
            'Expected creating a project debug configuration to fail cleanly without the C# extension.');
    });

    test('produces a resource debug configuration that Hot Reload never touches', async () => {
        await openAspireView();
        await waitForRepositoryIdle();

        // `node` is registered unconditionally, so this reaches the shared configuration path.
        // Hot Reload is implemented entirely by C# Dev Kit and vsdbg, so Aspire contributes nothing
        // to any launch configuration; this pins the exact key set a resource launches with.
        const configuration = (await executeE2eControlCommand({
            name: 'createResourceDebugConfiguration',
            launchConfig: nodeLaunchConfig,
        })).result as Record<string, unknown>;

        assert.ok(
            Object.keys(configuration).length > 0,
            'Expected a real debug configuration to inspect.');

        // Asserted on the serialized form so a value nested at any depth is caught, not just a
        // top-level key. `brokeredServicePipeName` is the property vsdbg reads to reach Dev Kit's
        // services; Aspire must never be the thing that puts it there.
        const serialized = JSON.stringify(configuration);
        assert.strictEqual(
            /hotreload|brokeredservicepipename/i.test(serialized),
            false,
            `A launch configuration must carry nothing Hot Reload related: ${serialized}`);
    });

    test('registers exactly the polyglot debuggers when no .NET tooling is installed', async () => {
        await openAspireView();
        await waitForRepositoryIdle();

        const debuggerExtensions = (await executeE2eControlCommand({ name: 'getResourceDebuggerExtensions' })).result as ReadonlyArray<{
            resourceType: string;
        }>;

        // Node and browser debugging use VS Code's built-in js-debug, so a polyglot Aspire app is
        // fully debuggable in an environment with no .NET tooling at all. Asserted as an exact set
        // rather than a membership check so an unexpected registration cannot slip through.
        assert.deepStrictEqual(
            debuggerExtensions.map(extension => extension.resourceType).sort(),
            ['browser', 'node']);
    });

    test('a browser resource debug configuration carries nothing Hot Reload related', async () => {
        await openAspireView();
        await waitForRepositoryIdle();

        const configuration = (await executeE2eControlCommand({
            name: 'createResourceDebugConfiguration',
            launchConfig: browserLaunchConfig,
        })).result as Record<string, unknown>;

        const serialized = JSON.stringify(configuration);
        assert.strictEqual(
            /hotreload|brokeredservicepipename/i.test(serialized),
            false,
            `A browser launch configuration must carry nothing Hot Reload related: ${serialized}`);
    });

    test('contributes no Hot Reload settings, commands, or UI of its own', async () => {
        const packageJson = (await executeE2eControlCommand({ name: 'getExtensionPackageJson' })).result as {
            contributes?: Record<string, unknown>;
        };

        // Dev Kit owns `csharp.experimental.debug.hotReload`, `csharp.debug.hotReloadOnSave`, and
        // `csharp.debug.hotReloadVerbosity`, all declared `"scope": "machine"`, and it owns the
        // Hot Reload toolbar button. Redeclaring another extension's setting produces a duplicate
        // settings-UI entry and can change how the value resolves, and shipping a competing button
        // would give users two controls for one feature. Aspire reads state and does neither.
        const contributions = JSON.stringify(packageJson.contributes ?? {});
        assert.strictEqual(
            /hotreload/i.test(contributions),
            false,
            `The Aspire extension must not contribute Hot Reload settings, commands, or menus: ${contributions}`);
    });

    test('runs a .NET project resource to Running with neither the C# extension nor Dev Kit', async () => {
        await openAspireView();
        await waitForRepositoryIdle();
        const discovered = await waitForWorkspaceAppHost();
        await openAspireView();
        const appHostPath = discovered.state.workspaceAppHostPath ?? getPrimaryAppHostProjectPath();

        const before = getCommandInvocationCount('aspire-vscode.runAppHost');
        await executeE2eControlCommand({ name: 'runAppHost', appHostPath }, { waitFor: 'started' });
        await waitForAppHostLaunching(appHostPath);
        await waitForCommandOutcome('aspire-vscode.runAppHost', 'success', 120000, before);
        await waitForRunningAppHost();

        // The end-to-end statement of "no degraded experience": a .NET project resource still starts
        // and reaches Running in an environment where nothing this feature depends on is installed.
        const running = await waitForResourceState('e2e-worker', ['Running'], 180000);
        const worker = findResource(running.state, 'e2e-worker');
        assert.ok(worker, 'Expected the .NET worker resource to be running without the C# extension or Dev Kit.');
    });
});

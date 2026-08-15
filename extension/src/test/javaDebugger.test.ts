import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getSupportedCapabilities } from '../capabilities';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { javaDebuggerExtension } from '../debugger/languages/java';
import { AspireResourceExtendedDebugConfiguration, GoLaunchConfiguration, JavaLaunchConfiguration } from '../dcp/types';

suite('Java Debugger Extension Tests', () => {
    const fakeAspireDebugSession = {} as AspireDebugSession;

    teardown(() => sinon.restore());

    test('advertises Java support when both Java extensions are installed', () => {
        stubInstalledExtensions(['redhat.java', 'vscjava.vscode-java-debug']);

        const capabilities = getSupportedCapabilities();
        assert.ok(capabilities.includes('java'));
        assert.ok(capabilities.includes('vscjava.vscode-java-debug'));
        assert.ok(getResourceDebuggerExtensions().some(extension => extension.resourceType === 'java'));
    });

    test('does not advertise Java support when only the debug adapter is installed', () => {
        stubInstalledExtensions(['vscjava.vscode-java-debug']);

        const capabilities = getSupportedCapabilities();
        assert.ok(!capabilities.includes('java'));
        assert.ok(!capabilities.includes('vscjava.vscode-java-debug'));
        assert.ok(!getResourceDebuggerExtensions().some(extension => extension.resourceType === 'java'));
    });

    test('does not advertise Java support when only the language server is installed', () => {
        stubInstalledExtensions(['redhat.java']);

        const capabilities = getSupportedCapabilities();
        assert.ok(!capabilities.includes('java'));
        assert.ok(!getResourceDebuggerExtensions().some(extension => extension.resourceType === 'java'));
    });

    test('configures the VS Code Java debugger from the launch configuration', async () => {
        const launchConfig: JavaLaunchConfiguration = {
            type: 'java',
            request: 'launch',
            working_directory: '/workspace/api',
            main_class: 'com.example.api.Application',
            build_tool: 'maven'
        };
        const debugConfig = createDebugConfig();
        stubInstalledExtensions([]);

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            launchConfig,
            ['--server.port=8080'],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.type, 'java');
        assert.strictEqual(debugConfig.request, 'launch');
        assert.strictEqual(debugConfig.cwd, '/workspace/api');
        assert.strictEqual(debugConfig.mainClass, 'com.example.api.Application');
        assert.deepStrictEqual(debugConfig.args, ['--server.port=8080']);
        assert.strictEqual(debugConfig.noDebug, false);
    });

    test('sets noDebug when launch option disables debugging', async () => {
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig(),
            [],
            [],
            { debug: false, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.noDebug, true);
    });

    test('honours an attach request from the launch configuration', async () => {
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ request: 'attach' }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.request, 'attach');
    });

    test('defaults to a launch request when the launch configuration omits one', async () => {
        const debugConfig = createDebugConfig({ request: 'attach' });

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ request: undefined }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.request, 'launch');
    });

    test('sets mainClass to the executable JAR path when the app host reports one', async () => {
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ main_class: '/workspace/api/target/api-1.0.0.jar' }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.mainClass, '/workspace/api/target/api-1.0.0.jar');
    });

    test('omits mainClass so the adapter resolves it when the app host does not report one', async () => {
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ main_class: undefined }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(!('mainClass' in debugConfig), 'mainClass must stay unset so the Java debugger resolves it from the project.');
    });

    test('forwards application arguments and defaults them to an empty array', async () => {
        const withArgs = createDebugConfig();
        const withoutArgs = createDebugConfig();
        const launchOptions = { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession };

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig(), ['--spring.profiles.active=dev', 'extra'], [], launchOptions, withArgs);
        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig(), undefined, [], launchOptions, withoutArgs);

        assert.deepStrictEqual(withArgs.args, ['--spring.profiles.active=dev', 'extra']);
        assert.deepStrictEqual(withoutArgs.args, []);
    });

    test('preserves the merged environment instead of replacing it with the resource variables', async () => {
        // prepareDebugSession already merged the inherited process environment with the resource's
        // variables. Overwriting env here would drop PATH and JAVA_HOME, so the JVM could not start.
        const debugConfig = createDebugConfig({
            env: { PATH: '/usr/bin', JAVA_HOME: '/opt/jdk-21', OTEL_SERVICE_NAME: 'api' }
        });

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig(),
            [],
            [{ name: 'OTEL_SERVICE_NAME', value: 'api' }, { name: 'ASPIRE_RESOURCE', value: 'api' }],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.deepStrictEqual(debugConfig.env, { PATH: '/usr/bin', JAVA_HOME: '/opt/jdk-21', OTEL_SERVICE_NAME: 'api' });
    });

    test('launches when the Java language server is not installed', async () => {
        stubInstalledExtensions([]);
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ build_tool: 'gradle' }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(debugConfig.type, 'java');
        assert.strictEqual(debugConfig.mainClass, 'com.example.api.Application');
    });

    test('launches when the project configuration refresh command rejects', async () => {
        stubJavaLanguageServer(true);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').rejects(new Error("command 'java.execute.workspaceCommand' not found"));
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ build_tool: 'maven' }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.ok(executeCommand.called, 'The refresh should be attempted when the language server reports ready.');
        assert.strictEqual(debugConfig.type, 'java');
        assert.strictEqual(debugConfig.cwd, '/workspace/api');
    });

    test('skips the project configuration refresh when the language server is not ready', async () => {
        stubJavaLanguageServer(false);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ build_tool: 'maven' }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(executeCommand.called, false);
        assert.strictEqual(debugConfig.type, 'java');
    });

    test('skips the project configuration refresh when the resource has no build tool', async () => {
        stubJavaLanguageServer(true);
        const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
        const debugConfig = createDebugConfig();

        await javaDebuggerExtension.createDebugSessionConfigurationCallback!(
            createJavaLaunchConfig({ build_tool: undefined }),
            [],
            [],
            { debug: true, runId: '1', debugSessionId: '1', isApphost: false, debugSession: fakeAspireDebugSession },
            debugConfig);

        assert.strictEqual(executeCommand.called, false);
        assert.strictEqual(debugConfig.type, 'java');
    });

    test('throws for a launch configuration that is not java', () => {
        const goLaunchConfig: GoLaunchConfiguration = { type: 'go', program: '/workspace/api' };

        assert.throws(
            () => javaDebuggerExtension.getProjectFile(goLaunchConfig),
            /Invalid launch configuration/);
    });

    test('returns the working directory as the project file', () => {
        assert.strictEqual(javaDebuggerExtension.getProjectFile(createJavaLaunchConfig()), '/workspace/api');
    });

    test('names the session after the main class when it is a class name', () => {
        assert.strictEqual(javaDebuggerExtension.getDisplayName(createJavaLaunchConfig()), 'Java: com.example.api.Application');
    });

    test('names the session with a workspace relative path rather than a file URI', () => {
        sinon.stub(vscode.workspace, 'asRelativePath').callsFake(() => 'api');

        const fromJar = javaDebuggerExtension.getDisplayName(createJavaLaunchConfig({ main_class: '/workspace/api/target/api-1.0.0.jar' }));
        const withoutMainClass = javaDebuggerExtension.getDisplayName(createJavaLaunchConfig({ main_class: undefined }));

        assert.strictEqual(fromJar, 'Java: api');
        assert.strictEqual(withoutMainClass, 'Java: api');
    });

    test('falls back to the Java label when there is nothing to name the session after', () => {
        const emptyLaunchConfig: JavaLaunchConfiguration = { type: 'java' };

        assert.strictEqual(javaDebuggerExtension.getDisplayName(emptyLaunchConfig), 'Java');
    });

    test('supports Java source files', () => {
        assert.deepStrictEqual(javaDebuggerExtension.getSupportedFileTypes(), ['.java']);
    });
});

function createJavaLaunchConfig(overrides: Partial<JavaLaunchConfiguration> = {}): JavaLaunchConfiguration {
    return {
        type: 'java',
        request: 'launch',
        working_directory: '/workspace/api',
        main_class: 'com.example.api.Application',
        build_tool: 'maven',
        ...overrides
    };
}

function createDebugConfig(overrides: Partial<AspireResourceExtendedDebugConfiguration> = {}): AspireResourceExtendedDebugConfiguration {
    return {
        runId: '1',
        debugSessionId: '1',
        type: 'java',
        name: 'Java',
        request: 'launch',
        program: '/workspace/api',
        args: [],
        ...overrides
    };
}

function stubInstalledExtensions(extensionIds: string[]): void {
    sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
        return extensionIds.includes(extensionId) ? { id: extensionId } as vscode.Extension<unknown> : undefined;
    });
}

// Stands in for the redhat.java extension API that java.ts waits on before refreshing the classpath.
function stubJavaLanguageServer(serverReady: boolean): void {
    sinon.stub(vscode.extensions, 'getExtension').callsFake((extensionId: string) => {
        if (extensionId !== 'redhat.java') {
            return undefined;
        }

        return {
            id: extensionId,
            isActive: true,
            exports: { serverMode: 'Standard', serverReady: async () => serverReady }
        } as unknown as vscode.Extension<unknown>;
    });
}

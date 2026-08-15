import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { AppHostDisplayInfo, ResourceJson } from '../data/AppHostDataRepository';
import { projectDebuggerExtension, projectResourceAttachProvider } from '../debugger/languages/dotnet';
import { ResourceAttachProvider, ResourceAttachProviderRegistry } from '../debugger/resourceAttachProviders';
import { ResourceDebugAppHostIdentityComparer, ResourceDebugAppHostRepository, ResourceDebugService } from '../debugger/resourceDebugService';
import { ResourceDebugSessionEvents, ResourceDebugSessionRegistry } from '../debugger/resourceDebugSessionRegistry';
import type { ResourceDebugAppHostTarget, ResourceDebugRequest, ResourceDebugResourceSnapshot } from '../debugger/resourceDebugContracts';

const target: ResourceDebugAppHostTarget = {
    absolutePath: '/repo/AppHost.csproj',
    displayPath: 'AppHost.csproj',
};

function createResource(overrides: Partial<ResourceJson> = {}): ResourceJson {
    return {
        name: 'api',
        displayName: 'API',
        resourceType: 'Project',
        state: 'Running',
        stateStyle: null,
        healthStatus: null,
        healthReports: null,
        exitCode: null,
        dashboardUrl: null,
        urls: null,
        commands: null,
        properties: {
            'project.path': '/repo/api/Api.csproj',
            'executable.path': 'dotnet',
        },
        ...overrides,
    };
}

function createAppHost(overrides: Partial<AppHostDisplayInfo> = {}): AppHostDisplayInfo {
    return {
        appHostPath: target.absolutePath,
        appHostPid: 42,
        cliPid: null,
        dashboardUrl: null,
        resources: [createResource()],
        ...overrides,
    };
}

function createRequest(overrides: Partial<ResourceDebugRequest> = {}): ResourceDebugRequest {
    return {
        source: 'tree',
        appHost: target,
        resourceName: 'api',
        ...overrides,
    };
}

function createProvider(overrides: Partial<ResourceAttachProvider> = {}): ResourceAttachProvider {
    return {
        id: 'dotnet',
        requiredDebuggerExtensions: [{
            id: 'ms-dotnettools.csharp',
            label: 'C#',
        }],
        canAttachToResource: () => true,
        createDebugConfiguration: async () => ({
            type: 'coreclr',
            request: 'attach',
            name: 'Attach debugger: API',
        }),
        ...overrides,
    };
}

class TestDebugSessionEvents implements ResourceDebugSessionEvents {
    private _startListener: ((session: vscode.DebugSession) => void) | undefined;
    private _terminateListener: ((session: vscode.DebugSession) => void) | undefined;

    onDidStartDebugSession(listener: (session: vscode.DebugSession) => void): vscode.Disposable {
        this._startListener = listener;
        return new vscode.Disposable(() => {
            this._startListener = undefined;
        });
    }

    onDidTerminateDebugSession(listener: (session: vscode.DebugSession) => void): vscode.Disposable {
        this._terminateListener = listener;
        return new vscode.Disposable(() => {
            this._terminateListener = undefined;
        });
    }

    start(configuration: vscode.DebugConfiguration): void {
        this._startListener?.({
            id: 'resource-attach-session',
            configuration,
        } as vscode.DebugSession);
    }

    terminate(configuration: vscode.DebugConfiguration): void {
        this._terminateListener?.({
            id: 'resource-attach-session',
            configuration,
        } as vscode.DebugSession);
    }
}

function createService(options: {
    appHosts?: readonly AppHostDisplayInfo[];
    provider?: ResourceAttachProvider;
    isExtensionInstalled?: (extensionId: string) => boolean;
    startDebugging?: (folder: vscode.WorkspaceFolder | undefined, configuration: vscode.DebugConfiguration) => Thenable<boolean>;
    compareAppHostIdentity?: ResourceDebugAppHostIdentityComparer;
} = {}): {
    service: ResourceDebugService;
    repository: ResourceDebugAppHostRepository;
    sessions: ResourceDebugSessionRegistry;
    events: TestDebugSessionEvents;
} {
    const repository: ResourceDebugAppHostRepository = {
        fetchAppHostsOnce: async () => options.appHosts ?? [createAppHost()],
    };
    const events = new TestDebugSessionEvents();
    const sessions = new ResourceDebugSessionRegistry(events);
    const providers = new ResourceAttachProviderRegistry(
        [options.provider ?? createProvider()],
        options.isExtensionInstalled ?? (() => true));
    const service = new ResourceDebugService({
        appHostRepository: repository,
        attachProviders: providers,
        sessionRegistry: sessions,
        startDebugging: options.startDebugging ?? (async () => true),
        compareAppHostIdentity: options.compareAppHostIdentity,
    });

    return { service, repository, sessions, events };
}

suite('Resource debug service', () => {
    teardown(() => sinon.restore());

    test('keeps ResourceDebuggerExtension launch-only', () => {
        assert.deepStrictEqual(
            Object.keys(projectDebuggerExtension).sort(),
            [
                'createDebugSessionConfigurationCallback',
                'debugAdapter',
                'extensionId',
                'getDisplayName',
                'getProjectFile',
                'getSupportedFileTypes',
                'resourceType',
            ]);
    });

    test('registers .NET attach behavior independently from the launch provider', () => {
        const providers = new ResourceAttachProviderRegistry([projectResourceAttachProvider], () => true);

        assert.strictEqual(providers.getKnownProviderForResource(createResource({
            properties: {
                'project.path': '/repo/api/Api.csproj',
                'executable.path': 'dotnet',
                'executable.pid': '42',
            },
        }))?.id, 'dotnet');
    });

    test('uses a fresh AppHost snapshot instead of a tree resource', async () => {
        let fetchCount = 0;
        let configuredResource: ResourceDebugResourceSnapshot | undefined;
        const repository: ResourceDebugAppHostRepository = {
            fetchAppHostsOnce: async () => {
                fetchCount++;
                return [createAppHost({
                    resources: [createResource({
                        properties: {
                            'project.path': '/repo/api/Api.csproj',
                            'executable.path': `dotnet-${fetchCount}`,
                        },
                    })],
                })];
            },
        };
        const provider = createProvider({
            createDebugConfiguration: async resource => {
                configuredResource = resource;
                return { type: 'coreclr', request: 'attach', name: 'Attach debugger: API' };
            },
        });
        const events = new TestDebugSessionEvents();
        const sessions = new ResourceDebugSessionRegistry(events);
        const service = new ResourceDebugService({
            appHostRepository: repository,
            attachProviders: new ResourceAttachProviderRegistry([provider], () => true),
            sessionRegistry: sessions,
            startDebugging: async () => true,
        });

        const result = await service.debug(createRequest());

        assert.deepStrictEqual(result, { outcome: 'started', providerId: 'dotnet' });
        assert.strictEqual(fetchCount, 1);
        assert.strictEqual(configuredResource?.properties?.['executable.path'], 'dotnet-1');
        sessions.dispose();
    });

    test('resolves duplicate resource names only within the requested AppHost', async () => {
        let configuredResource: ResourceDebugResourceSnapshot | undefined;
        const { service, sessions } = createService({
            appHosts: [
                createAppHost({
                    appHostPath: '/repo/first/AppHost.csproj',
                    resources: [createResource({ displayName: 'First API' })],
                }),
                createAppHost({
                    appHostPath: target.absolutePath,
                    resources: [createResource({ displayName: 'Second API' })],
                }),
            ],
            provider: createProvider({
                createDebugConfiguration: async resource => {
                    configuredResource = resource;
                    return { type: 'coreclr', request: 'attach', name: 'Attach debugger: Second API' };
                },
            }),
        });

        const result = await service.debug(createRequest());

        assert.deepStrictEqual(result, { outcome: 'started', providerId: 'dotnet' });
        assert.strictEqual(configuredResource?.displayName, 'Second API');
        sessions.dispose();
    });

    test('fails closed when the AppHost identity is ambiguous', async () => {
        const { service, sessions } = createService({
            compareAppHostIdentity: () => 'ambiguous',
        });

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'appHostNotFound' });
        sessions.dispose();
    });

    test('fails closed when one matching AppHost identity is ambiguous', async () => {
        const { service, sessions } = createService({
            appHosts: [
                createAppHost(),
                createAppHost({ appHostPath: '/repo/ambiguous/AppHost.csproj' }),
            ],
            compareAppHostIdentity: (_requestedPath, appHostPath) =>
                appHostPath === target.absolutePath ? 'same' : 'ambiguous',
        });

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'appHostNotFound' });
        sessions.dispose();
    });

    test('fails closed when a resource is stale or duplicated', async () => {
        const missing = createService({
            appHosts: [createAppHost({ resources: [] })],
        });
        const duplicated = createService({
            appHosts: [createAppHost({ resources: [createResource(), createResource()] })],
        });

        assert.deepStrictEqual(await missing.service.debug(createRequest()), { outcome: 'resourceNotFound' });
        assert.deepStrictEqual(await duplicated.service.debug(createRequest()), { outcome: 'resourceNotFound' });
        missing.sessions.dispose();
        duplicated.sessions.dispose();
    });

    test('reports a missing debugger extension without exposing resource details', async () => {
        const { service, sessions } = createService({
            isExtensionInstalled: () => false,
        });

        assert.deepStrictEqual(await service.debug(createRequest()), {
            outcome: 'debuggerExtensionMissing',
            debuggerExtensions: [{ id: 'ms-dotnettools.csharp', label: 'C#' }],
        });
        sessions.dispose();
    });

    test('returns typed outcomes for unsupported and stopped resources', async () => {
        const unsupported = createService({
            provider: createProvider({ canAttachToResource: () => false }),
        });
        const stopped = createService({
            appHosts: [createAppHost({ resources: [createResource({ state: 'Finished' })] })],
        });

        assert.deepStrictEqual(await unsupported.service.debug(createRequest()), { outcome: 'unsupportedResource' });
        assert.deepStrictEqual(await stopped.service.debug(createRequest()), { outcome: 'resourceNotRunning' });
        unsupported.sessions.dispose();
        stopped.sessions.dispose();
    });

    test('normalizes provider eligibility errors without exposing their details', async () => {
        const { service, sessions } = createService({
            provider: createProvider({
                canAttachToResource: () => {
                    throw new Error('process 1234 at /repo/private/Api.dll');
                },
            }),
        });

        const result = await service.debug(createRequest());

        assert.deepStrictEqual(result, { outcome: 'error', errorKind: 'providerResolutionFailed' });
        assert.doesNotMatch(JSON.stringify(result), /1234|\/repo|Api\.dll/);
        sessions.dispose();
    });

    test('serializes concurrent requests and returns alreadyDebugging for the duplicate', async () => {
        let completeStart: ((value: boolean) => void) | undefined;
        let markStartCalled: (() => void) | undefined;
        const startRequest = new Promise<boolean>(resolve => {
            completeStart = resolve;
        });
        const startCalled = new Promise<void>(resolve => {
            markStartCalled = resolve;
        });
        const startDebugging = sinon.stub().callsFake(() => {
            markStartCalled!();
            return startRequest;
        });
        const { service, repository, sessions } = createService({ startDebugging });
        let fetchCount = 0;
        repository.fetchAppHostsOnce = async () => {
            fetchCount++;
            return [createAppHost()];
        };

        const first = service.debug(createRequest());
        const second = service.debug(createRequest());
        await startCalled;
        assert.strictEqual(startDebugging.callCount, 1);
        assert.strictEqual(fetchCount, 1);

        completeStart!(true);

        assert.deepStrictEqual(await first, { outcome: 'started', providerId: 'dotnet' });
        assert.deepStrictEqual(await second, { outcome: 'alreadyDebugging' });
        sessions.dispose();
    });

    test('returns alreadyDebugging while an independent attach session is active', async () => {
        const { service, sessions } = createService();

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });
        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'alreadyDebugging' });
        sessions.dispose();
    });

    test('returns a bounded failure when VS Code declines to start debugging', async () => {
        const { service, sessions } = createService({
            startDebugging: async () => false,
        });

        assert.deepStrictEqual(await service.debug(createRequest()), {
            outcome: 'error',
            errorKind: 'debuggerStartDeclined',
        });
        sessions.dispose();
    });

    test('normalizes configuration errors without exposing their details', async () => {
        const { service, sessions } = createService({
            provider: createProvider({
                createDebugConfiguration: async () => {
                    throw new Error('process 1234 at /repo/private/Api.dll');
                },
            }),
        });

        const result = await service.debug(createRequest());

        assert.deepStrictEqual(result, { outcome: 'error', errorKind: 'configurationFailed' });
        assert.doesNotMatch(JSON.stringify(result), /1234|\/repo|Api\.dll/);
        sessions.dispose();
    });

    test('returns cancelled when the request cancellation token is already cancelled', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();
        const startDebugging = sinon.stub().resolves(true);
        const { service, sessions } = createService({ startDebugging });

        assert.deepStrictEqual(await service.debug(createRequest({ cancellationToken: cancellation.token })), {
            outcome: 'cancelled',
        });
        assert.strictEqual(startDebugging.callCount, 0);
        cancellation.dispose();
        sessions.dispose();
    });

    test('does not start debugging when cancellation occurs during configuration', async () => {
        let finishConfiguration: (() => void) | undefined;
        let markConfigurationStarted: (() => void) | undefined;
        const configuration = new Promise<void>(resolve => {
            finishConfiguration = resolve;
        });
        const configurationStarted = new Promise<void>(resolve => {
            markConfigurationStarted = resolve;
        });
        const cancellation = new vscode.CancellationTokenSource();
        const startDebugging = sinon.stub().resolves(true);
        const { service, sessions } = createService({
            provider: createProvider({
                createDebugConfiguration: async () => {
                    markConfigurationStarted!();
                    await configuration;
                    return { type: 'coreclr', request: 'attach', name: 'Attach debugger: API' };
                },
            }),
            startDebugging,
        });

        const operation = service.debug(createRequest({ cancellationToken: cancellation.token }));
        await configurationStarted;
        cancellation.cancel();
        finishConfiguration!();

        assert.deepStrictEqual(await operation, { outcome: 'cancelled' });
        assert.strictEqual(startDebugging.callCount, 0);
        cancellation.dispose();
        sessions.dispose();
    });

    test('removes a terminated independent attach session without stopping its resource', async () => {
        let startedConfiguration: vscode.DebugConfiguration | undefined;
        const { service, sessions, events } = createService({
            startDebugging: async (_folder, configuration) => {
                startedConfiguration = configuration;
                events.start(configuration);
                return true;
            },
        });

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });
        assert.ok(startedConfiguration);
        assert.strictEqual(sessions.hasActiveSession(target, 'api'), true);

        events.terminate(startedConfiguration!);

        assert.strictEqual(sessions.hasActiveSession(target, 'api'), false);
        sessions.dispose();
    });
});

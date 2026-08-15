import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { AppHostDisplayInfo, ResourceJson } from '../data/AppHostDataRepository';
import { createProjectResourceAttachProvider, projectDebuggerExtension, projectResourceAttachProvider } from '../debugger/languages/dotnet';
import { ResourceAttachProviderRegistry } from '../debugger/resourceAttachProviders';
import { ResourceDebugAppHostIdentityComparer, ResourceDebugAppHostRepository, ResourceDebugService } from '../debugger/resourceDebugService';
import { ResourceDebugSessionEvents, ResourceDebugSessionRegistry } from '../debugger/resourceDebugSessionRegistry';
import { ResourceAttachConfigurationError, type ResourceAttachProvider, type ResourceDebugAppHostTarget, type ResourceDebugRequest, type ResourceDebugResourceSnapshot } from '../debugger/resourceDebugContracts';
import { extensionLogOutputChannel } from '../utils/logging';

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
        canRecognizeResource: () => true,
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
    providers?: readonly ResourceAttachProvider[];
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
        fetchRunningAppHostsOnce: async () => options.appHosts ?? [createAppHost()],
        fetchAppHostResourcesOnce: async appHostPath =>
            (options.appHosts ?? [createAppHost()]).find(appHost => appHost.appHostPath === appHostPath)?.resources ?? [],
    };
    const events = new TestDebugSessionEvents();
    const sessions = new ResourceDebugSessionRegistry(events);
    const providers = new ResourceAttachProviderRegistry(
        options.providers ?? [options.provider ?? createProvider()],
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

        assert.strictEqual(providers.getRecognizedProviderForResource(createResource({
            properties: {
                'project.path': '/repo/api/Api.csproj',
                'executable.path': 'dotnet',
                'executable.pid': '42',
            },
        }))?.id, 'dotnet');
    });

    test('uses the first recognized provider for readiness and configuration', async () => {
        const firstProvider = createProvider({
            canAttachToResource: sinon.stub().returns(false),
            createDebugConfiguration: sinon.stub().rejects(new Error('first provider should not configure')),
        });
        const secondProvider = createProvider({
            canAttachToResource: sinon.stub().returns(true),
            createDebugConfiguration: sinon.stub().resolves({
                type: 'coreclr',
                request: 'attach',
                name: 'Attach debugger: second provider',
            }),
        });
        const startDebugging = sinon.stub().resolves(true);
        const { service, sessions } = createService({
            providers: [firstProvider, secondProvider],
            startDebugging,
        });

        try {
            assert.strictEqual(service.canAttachToResource(createResource()), false);
            assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'unsupportedResource' });
            assert.strictEqual((firstProvider.canAttachToResource as sinon.SinonStub).callCount, 2);
            assert.strictEqual((firstProvider.createDebugConfiguration as sinon.SinonStub).callCount, 0);
            assert.strictEqual((secondProvider.canAttachToResource as sinon.SinonStub).callCount, 0);
            assert.strictEqual((secondProvider.createDebugConfiguration as sinon.SinonStub).callCount, 0);
            assert.strictEqual(startDebugging.callCount, 0);
        }
        finally {
            sessions.dispose();
        }
    });

    test('uses a fresh AppHost snapshot instead of a tree resource', async () => {
        let fetchCount = 0;
        let configuredResource: ResourceDebugResourceSnapshot | undefined;
        const repository: ResourceDebugAppHostRepository = {
            fetchRunningAppHostsOnce: async () => {
                return [createAppHost({ resources: null })];
            },
            fetchAppHostResourcesOnce: async () => {
                fetchCount++;
                return [createResource({
                    properties: {
                        'project.path': '/repo/api/Api.csproj',
                        'executable.path': `dotnet-${fetchCount}`,
                    },
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

    test('resolves the running AppHost before fetching only its resource snapshot', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        const fetchedPaths: string[] = [];
        const receivedTokens: Array<vscode.CancellationToken | undefined> = [];
        const repository: ResourceDebugAppHostRepository = {
            fetchRunningAppHostsOnce: async token => {
                assert.strictEqual(token, cancellation.token);
                return [
                    createAppHost({ appHostPath: '/repo/other/AppHost.csproj', resources: null }),
                    createAppHost({ appHostPath: '/repo/resolved/AppHost.csproj', resources: null }),
                ];
            },
            fetchAppHostResourcesOnce: async (appHostPath, token) => {
                fetchedPaths.push(appHostPath);
                receivedTokens.push(token);
                return [createResource()];
            },
        };
        const events = new TestDebugSessionEvents();
        const sessions = new ResourceDebugSessionRegistry(events);
        const service = new ResourceDebugService({
            appHostRepository: repository,
            attachProviders: new ResourceAttachProviderRegistry([createProvider()], () => true),
            sessionRegistry: sessions,
            startDebugging: async () => true,
            compareAppHostIdentity: (requestedPath, appHostPath) =>
                requestedPath === '/repo/alias/AppHost.csproj' && appHostPath === '/repo/resolved/AppHost.csproj'
                    ? 'same'
                    : 'different',
        });

        try {
            const result = await service.debug(createRequest({
                appHost: { absolutePath: '/repo/alias/AppHost.csproj', displayPath: 'alias/AppHost.csproj' },
                cancellationToken: cancellation.token,
            }));

            assert.deepStrictEqual(result, { outcome: 'started', providerId: 'dotnet' });
            assert.deepStrictEqual(fetchedPaths, ['/repo/resolved/AppHost.csproj']);
            assert.deepStrictEqual(receivedTokens, [cancellation.token]);
        }
        finally {
            cancellation.dispose();
            sessions.dispose();
        }
    });

    test('returns a snapshot failure when the selected AppHost cannot be described', async () => {
        const logError = sinon.stub(extensionLogOutputChannel, 'error');
        const { service, sessions, repository } = createService();
        repository.fetchAppHostResourcesOnce = async () => {
            throw new Error('process 1234 at /repo/private/AppHost.csproj');
        };

        try {
            const result = await service.debug(createRequest());

            assert.deepStrictEqual(result, { outcome: 'error', errorKind: 'resourceSnapshotFailed' });
            assert.doesNotMatch(JSON.stringify(result), /1234|\/repo|AppHost\.csproj/);
            assert.ok(logError.calledOnce);
        }
        finally {
            sessions.dispose();
        }
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

    test('keeps a typed configuration failure when the provider rejects an unattached resource', async () => {
        const logError = sinon.stub(extensionLogOutputChannel, 'error');
        const { service, sessions } = createService({
            provider: createProvider({
                createDebugConfiguration: async () => {
                    throw new ResourceAttachConfigurationError('resourceNotAttachable', 'process 1234 at /repo/private/Api.dll');
                },
            }),
        });

        try {
            const result = await service.debug(createRequest());

            assert.deepStrictEqual(result, { outcome: 'error', errorKind: 'configurationFailed' });
            assert.doesNotMatch(JSON.stringify(result), /1234|\/repo|Api\.dll/);
            assert.ok(logError.calledOnce);
        }
        finally {
            sessions.dispose();
        }
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

    test('checks attach eligibility before reporting a missing debugger extension', async () => {
        const { service, sessions } = createService({
            provider: createProvider({ canAttachToResource: () => false }),
            isExtensionInstalled: () => false,
        });

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'unsupportedResource' });
        sessions.dispose();
    });

    test('returns typed outcomes for unsupported and stopped resources', async () => {
        const unsupported = createService({
            provider: createProvider({ canAttachToResource: () => false }),
        });
        const stopped = createService({
            appHosts: [createAppHost({ resources: [createResource({ state: 'Finished' })] })],
            provider: createProvider({ canAttachToResource: () => false }),
        });

        assert.deepStrictEqual(await unsupported.service.debug(createRequest()), { outcome: 'unsupportedResource' });
        assert.deepStrictEqual(await stopped.service.debug(createRequest()), { outcome: 'resourceNotRunning' });
        unsupported.sessions.dispose();
        stopped.sessions.dispose();
    });

    test('recognizes stopped .NET resources before checking attach readiness', async () => {
        const stopped = createService({
            appHosts: [createAppHost({ resources: [createResource({ state: 'Finished' })] })],
            provider: projectResourceAttachProvider,
        });

        assert.deepStrictEqual(await stopped.service.debug(createRequest()), { outcome: 'resourceNotRunning' });
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
        repository.fetchRunningAppHostsOnce = async () => {
            fetchCount++;
            return [createAppHost()];
        };

        const first = service.debug(createRequest());
        const second = service.debug(createRequest());
        await startCalled;
        assert.strictEqual(startDebugging.callCount, 1);
        assert.strictEqual(fetchCount, 2);

        completeStart!(true);

        assert.deepStrictEqual(await first, { outcome: 'started', providerId: 'dotnet' });
        assert.deepStrictEqual(await second, { outcome: 'alreadyDebugging' });
        sessions.dispose();
    });

    test('cancels a request while it waits for the resource lock', async () => {
        let completeStart: ((value: boolean) => void) | undefined;
        let signalStart: (() => void) | undefined;
        let signalSecondIdentityFetch: (() => void) | undefined;
        const startRequest = new Promise<boolean>(resolve => {
            completeStart = resolve;
        });
        const startCalled = new Promise<void>(resolve => {
            signalStart = resolve;
        });
        const secondIdentityFetch = new Promise<void>(resolve => {
            signalSecondIdentityFetch = resolve;
        });
        const startDebugging = sinon.stub().callsFake(() => {
            signalStart!();
            return startRequest;
        });
        const { service, repository, sessions } = createService({ startDebugging });
        let identityFetchCount = 0;
        let resourceSnapshotCount = 0;
        repository.fetchRunningAppHostsOnce = async () => {
            identityFetchCount++;
            if (identityFetchCount === 2) {
                signalSecondIdentityFetch!();
            }
            return [createAppHost({ resources: null })];
        };
        repository.fetchAppHostResourcesOnce = async () => {
            resourceSnapshotCount++;
            return [createResource()];
        };
        const cancellation = new vscode.CancellationTokenSource();

        try {
            const first = service.debug(createRequest());
            await startCalled;

            const second = service.debug(createRequest({ cancellationToken: cancellation.token }));
            await secondIdentityFetch;
            cancellation.cancel();

            assert.deepStrictEqual(await second, { outcome: 'cancelled' });
            assert.strictEqual(resourceSnapshotCount, 1);

            completeStart!(true);
            assert.deepStrictEqual(await first, { outcome: 'started', providerId: 'dotnet' });
        }
        finally {
            cancellation.dispose();
            sessions.dispose();
        }
    });

    test('keeps a later request blocked when a canceled waiter has already completed', async () => {
        const sessions = new ResourceDebugSessionRegistry();
        let releaseFirst: (() => void) | undefined;
        let firstEntered: (() => void) | undefined;
        let firstCompleted = false;
        const firstCanComplete = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const firstHasEntered = new Promise<void>(resolve => {
            firstEntered = resolve;
        });
        const cancellation = new vscode.CancellationTokenSource();
        let laterWaiterStarted = false;

        try {
            const first = sessions.runSerialized(
                target,
                'api',
                undefined,
                async () => {
                    firstEntered!();
                    await firstCanComplete;
                    firstCompleted = true;
                    return 'first';
                },
                () => 'cancelled');
            await firstHasEntered;

            const canceledWaiter = sessions.runSerialized(
                target,
                'api',
                cancellation.token,
                async () => 'second',
                () => 'cancelled');

            cancellation.cancel();

            assert.strictEqual(await canceledWaiter, 'cancelled');
            assert.strictEqual(firstCompleted, false);

            const laterWaiter = sessions.runSerialized(
                target,
                'api',
                undefined,
                async () => {
                    laterWaiterStarted = true;
                    return 'third';
                },
                () => 'cancelled');
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(laterWaiterStarted, false);

            releaseFirst!();
            assert.strictEqual(await first, 'first');
            assert.strictEqual(await laterWaiter, 'third');
        }
        finally {
            cancellation.dispose();
            sessions.dispose();
        }
    });

    test('passes the request cancellation token to providers that support cancellation', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        let receivedToken: vscode.CancellationToken | undefined;
        const { service, sessions } = createService({
            provider: createProvider({
                createDebugConfiguration: async (_resource, token) => {
                    receivedToken = token;
                    return { type: 'coreclr', request: 'attach', name: 'Attach debugger: API' };
                },
            }),
        });

        try {
            assert.deepStrictEqual(await service.debug(createRequest({ cancellationToken: cancellation.token })), {
                outcome: 'started',
                providerId: 'dotnet',
            });
            assert.strictEqual(receivedToken, cancellation.token);
        }
        finally {
            cancellation.dispose();
            sessions.dispose();
        }
    });

    test('returns cancelled when .NET target discovery observes request cancellation', async () => {
        let receivedToken: vscode.CancellationToken | undefined;
        let signalTargetDiscoveryStarted: (() => void) | undefined;
        const targetDiscoveryStarted = new Promise<void>(resolve => {
            signalTargetDiscoveryStarted = resolve;
        });
        const provider = createProjectResourceAttachProvider(() => ({
            getAndActivateDevKit: async () => false,
            buildDotNetProject: async () => { },
            getDotNetAttachTargetInfo: async (
                _projectFile: string,
                _configuration: string | undefined,
                cancellationToken: vscode.CancellationToken | undefined) => {
                receivedToken = cancellationToken;
                signalTargetDiscoveryStarted!();
                return await new Promise<never>((_resolve, reject) => {
                    cancellationToken?.onCancellationRequested(() => reject(new vscode.CancellationError()));
                });
            },
            getDotNetTargetPath: async () => '',
            getDotNetRunApiOutput: async () => '',
        } as never));
        const cancellation = new vscode.CancellationTokenSource();
        const startDebugging = sinon.stub().resolves(true);
        const { service, sessions } = createService({
            appHosts: [createAppHost({
                resources: [createResource({
                    properties: {
                        'project.path': '/repo/api/Api.csproj',
                        'executable.path': 'dotnet',
                        'executable.pid': '42',
                    },
                })],
            })],
            provider,
            startDebugging,
        });

        try {
            const operation = service.debug(createRequest({ cancellationToken: cancellation.token }));
            await targetDiscoveryStarted;
            cancellation.cancel();

            const result = await Promise.race([
                operation,
                new Promise<'timedOut'>(resolve => setTimeout(() => resolve('timedOut'), 100)),
            ]);
            assert.deepStrictEqual(result, { outcome: 'cancelled' });
            assert.strictEqual(receivedToken, cancellation.token);
            assert.strictEqual(startDebugging.callCount, 0);
        }
        finally {
            cancellation.dispose();
            sessions.dispose();
        }
    });

    test('returns alreadyDebugging while an independent attach session is active', async () => {
        const { service, sessions } = createService();

        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });
        assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'alreadyDebugging' });
        sessions.dispose();
    });

    test('logs marker-loss expiry before allowing a recovery attach attempt', async () => {
        const clock = sinon.useFakeTimers();
        const logWarning = sinon.stub(extensionLogOutputChannel, 'warn');
        const events = new TestDebugSessionEvents();
        const sessions = new ResourceDebugSessionRegistry(events, { pendingStartTimeoutMs: 100 });
        const service = new ResourceDebugService({
            appHostRepository: {
                fetchRunningAppHostsOnce: async () => [createAppHost({ resources: null })],
                fetchAppHostResourcesOnce: async () => [createResource()],
            },
            attachProviders: new ResourceAttachProviderRegistry([createProvider()], () => true),
            sessionRegistry: sessions,
            startDebugging: async () => true,
        });

        try {
            assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });

            // A third-party debug configuration provider can resolve the session without preserving
            // private properties from the launch configuration.
            events.start({ type: 'coreclr', request: 'attach', name: 'Attach debugger: API' });
            await clock.tickAsync(100);

            assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });
            assert.ok(logWarning.calledOnceWithExactly(
                'Resource debugger session tracking expired before its debug session reported the private marker. A later attach may start another session.'));
        }
        finally {
            sessions.dispose();
            clock.restore();
        }
    });

    test('keeps an accepted start active when a correlated independent session starts', async () => {
        const clock = sinon.useFakeTimers();
        const events = new TestDebugSessionEvents();
        const sessions = new ResourceDebugSessionRegistry(events, { pendingStartTimeoutMs: 100 });
        let startedConfiguration: vscode.DebugConfiguration | undefined;
        const service = new ResourceDebugService({
            appHostRepository: {
                fetchRunningAppHostsOnce: async () => [createAppHost({ resources: null })],
                fetchAppHostResourcesOnce: async () => [createResource()],
            },
            attachProviders: new ResourceAttachProviderRegistry([createProvider()], () => true),
            sessionRegistry: sessions,
            startDebugging: async (_folder, configuration) => {
                startedConfiguration = configuration;
                events.start(configuration);
                return true;
            },
        });

        try {
            assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'started', providerId: 'dotnet' });
            assert.ok(startedConfiguration);
            await clock.tickAsync(100);

            assert.deepStrictEqual(await service.debug(createRequest()), { outcome: 'alreadyDebugging' });
        }
        finally {
            sessions.dispose();
            clock.restore();
        }
    });

    test('does not reactivate an attempt terminated before start acceptance', () => {
        const events = new TestDebugSessionEvents();
        const sessions = new ResourceDebugSessionRegistry(events);
        const attempt = sessions.createAttempt(target, 'api', {
            type: 'coreclr',
            request: 'attach',
            name: 'Attach debugger: API',
        });

        try {
            events.terminate(attempt.configuration);
            attempt.markStarted();

            assert.strictEqual(sessions.hasActiveSession(target, 'api'), false);
        }
        finally {
            sessions.dispose();
        }
    });

    test('serializes aliases that resolve to the same running AppHost', async () => {
        let completeStart: ((value: boolean) => void) | undefined;
        let signalStart: (() => void) | undefined;
        const startRequest = new Promise<boolean>(resolve => {
            completeStart = resolve;
        });
        const startCalled = new Promise<void>(resolve => {
            signalStart = resolve;
        });
        const startDebugging = sinon.stub().callsFake(() => {
            signalStart!();
            return startRequest;
        });
        const { service, sessions } = createService({
            startDebugging,
            compareAppHostIdentity: () => 'same',
            appHosts: [createAppHost({ appHostPath: '/repo/resolved/AppHost.csproj' })],
        });
        const first = service.debug(createRequest({
            appHost: { absolutePath: '/repo/alias-one/AppHost.csproj', displayPath: 'alias-one/AppHost.csproj' },
        }));
        const second = service.debug(createRequest({
            appHost: { absolutePath: '/repo/alias-two/AppHost.csproj', displayPath: 'alias-two/AppHost.csproj' },
        }));

        await startCalled;
        assert.strictEqual(startDebugging.callCount, 1);

        completeStart!(true);

        assert.deepStrictEqual(await first, { outcome: 'started', providerId: 'dotnet' });
        assert.deepStrictEqual(await second, { outcome: 'alreadyDebugging' });
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

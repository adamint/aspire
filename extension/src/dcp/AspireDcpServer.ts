import express, { Request, Response, NextFunction } from 'express';
import https from 'https';
import WebSocket, { WebSocketServer } from 'ws';
import * as vscode from 'vscode';
import { createSelfSignedCertAsync, generateToken } from '../utils/security';
import { extensionLogOutputChannel } from '../utils/logging';
import { AspireResourceDebugSession, DcpServerConnectionInfo, ErrorDetails, ErrorResponse, ProcessRestartedNotification, RunSessionNotification, RunSessionPayload, ServiceLogsNotification, SessionMessageNotification, SessionTerminatedNotification } from './types';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { createDebugSessionConfiguration, getResourceDebuggerExtensions } from '../debugger/debuggerExtensions';
import { cleanupRun } from '../debugger/runCleanupRegistry';
import { createDebugAdapterTracker } from '../debugger/adapterTracker';
import { timingSafeEqual } from 'crypto';
import { getRunSessionInfo, getSupportedCapabilities } from '../capabilities';
import { authorizationAndDcpHeadersRequired, authorizationHeaderMustStartWithBearer, encounteredErrorStartingResource, invalidOrMissingToken, invalidTokenLength } from '../loc/strings';
import { AcquiredTestRunSession, TestRunSessionAcquireOptions, TestRunSessionLease, TestRunSessionManager } from './TestRunSessionManager';

type AuthorizedDcpRequest = {
    dcpId: string;
    token: string;
    testRunSessionLease?: TestRunSessionLease;
};

export default class AspireDcpServer {
    private readonly app: express.Express;
    private server: https.Server;
    private wss: WebSocketServer;
    private wsBySession: Map<string, WebSocket> = new Map();
    private runsBySession: Map<string, AspireResourceDebugSession[]> = new Map();
    private testRunSessionLeaseIdByRunId: Map<string, string> = new Map();
    private debugAdapterTrackerDisposablesByAdapter: Map<string, vscode.Disposable> = new Map();
    private pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]> = new Map();
    private testRunSessionManager: TestRunSessionManager;

    public readonly connectionInfo: DcpServerConnectionInfo;

    private constructor(
        info: DcpServerConnectionInfo,
        app: express.Express,
        server: https.Server,
        wss: WebSocketServer,
        runsBySession: Map<string, AspireResourceDebugSession[]>,
        testRunSessionLeaseIdByRunId: Map<string, string>,
        wsBySession: Map<string, WebSocket>,
        pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]>,
        testRunSessionManager: TestRunSessionManager) {
        this.connectionInfo = info;
        this.app = app;
        this.server = server;
        this.wss = wss;
        this.runsBySession = runsBySession;
        this.testRunSessionLeaseIdByRunId = testRunSessionLeaseIdByRunId;
        this.wsBySession = wsBySession;
        this.pendingNotificationQueueByDcpId = pendingNotificationQueueByDcpId;
        this.testRunSessionManager = testRunSessionManager;
    }

    static async create(getDebugSession: (debugSessionId: string) => AspireDebugSession | null): Promise<AspireDcpServer> {
        const runsBySession = new Map<string, AspireResourceDebugSession[]>();
        const wsBySession = new Map<string, WebSocket>();
        const pendingNotificationQueueByDcpId = new Map<string, RunSessionNotification[]>();
        let testRunSessionManager: TestRunSessionManager | undefined;
        let dcpServerInstance: AspireDcpServer | undefined;

        return new Promise(async (resolve, reject) => {
            const token = generateToken();

            const app = express();
            app.use(express.json());
            const testRunSessionLeaseIdByRunId = new Map<string, string>();

            function requireHeaders(req: Request, res: Response, next: NextFunction): void {
                const authorization = authorizeDcpRequest(req.header('Authorization'), req.header('microsoft-developer-dcp-instance-id'));
                if (!authorization) {
                    respondWithError(res, 401, { error: { code: 'MissingHeaders', message: authorizationAndDcpHeadersRequired, details: [] } });
                    return;
                }

                if (authorization === 'invalid-auth-header') {
                    respondWithError(res, 401, { error: { code: 'InvalidAuthHeader', message: authorizationHeaderMustStartWithBearer, details: [] } });
                    return;
                }

                if (authorization === 'invalid-token-length') {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidTokenLength, details: [] } });
                    return;
                }

                if (authorization === 'invalid-token') {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidOrMissingToken, details: [] } });
                    return;
                }

                (req as Request & { aspireDcpAuthorization?: AuthorizedDcpRequest }).aspireDcpAuthorization = authorization;
                next();
            }

            function authorizeDcpRequest(auth: string | undefined, dcpId: string | undefined): AuthorizedDcpRequest | 'invalid-auth-header' | 'invalid-token-length' | 'invalid-token' | undefined {
                if (!auth || !dcpId) {
                    return undefined;
                }

                if (!auth.startsWith('Bearer ')) {
                    return 'invalid-auth-header';
                }

                const bearerToken = auth.substring('Bearer '.length);
                const testRunSessionLease = testRunSessionManager?.tryAuthorizeDcpRequest(dcpId, bearerToken);
                if (testRunSessionLease) {
                    return { dcpId, token: bearerToken, testRunSessionLease };
                }

                const bearerTokenBuffer = Buffer.from(bearerToken);
                const expectedTokenBuffer = Buffer.from(token);

                if (bearerTokenBuffer.length !== expectedTokenBuffer.length) {
                    return 'invalid-token-length';
                }

                // timingSafeEqual is used to verify that the tokens are equivalent in a way that mitigates timing attacks
                if (timingSafeEqual(bearerTokenBuffer, expectedTokenBuffer) === false) {
                    return 'invalid-token';
                }

                return { dcpId, token: bearerToken };
            }

            app.get("/telemetry/enabled", (req: Request, res: Response) => {
                // TODO enable dashboard telemetry
                res.json({ is_enabled: false });
            });

            app.get('/info', (req: Request, res: Response) => {
                res.json(getRunSessionInfo());
            });

            app.put('/run_session', requireHeaders, async (req: Request, res: Response) => {
                const payload: RunSessionPayload = req.body;
                const runId = generateRunId();
                const authorization = (req as Request & { aspireDcpAuthorization: AuthorizedDcpRequest }).aspireDcpAuthorization;
                const dcpId = authorization.dcpId;
                const debugSessionId = getDcpIdPrefix(dcpId) ?? authorization.testRunSessionLease?.sessionId;
                const processes: AspireResourceDebugSession[] = [];

                if (!debugSessionId) {
                    const error: ErrorDetails = {
                        code: 'MissingDebugSessionId',
                        message: 'Missing valid DCP prefix corresponding to an Aspire debug session.',
                        details: []
                    };

                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${error.message}`);
                    const response: ErrorResponse = { error };
                    respondWithError(res, 400, response);
                    return;
                }

                const launchConfig = payload.launch_configurations[0];
                const foundDebuggerExtension = getResourceDebuggerExtensions().find(ext => ext.resourceType === launchConfig.type) ?? null;

                if (!foundDebuggerExtension) {
                    const error: ErrorDetails = {
                        code: 'UnsupportedLaunchConfiguration',
                        message: `Unsupported launch configuration type: ${launchConfig.type}`,
                        details: []
                    };

                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${error.message}`);
                    const response: ErrorResponse = { error };
                    respondWithError(res, 400, response);
                    return;
                }

                const aspireDebugSession = getDebugSession(debugSessionId);
                if (!aspireDebugSession && !authorization.testRunSessionLease) {
                    const error: ErrorDetails = {
                        code: 'DebugSessionNotFound',
                        message: `No Aspire debug session found for Debug Session ID ${debugSessionId}`,
                        details: []
                    };

                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${error.message}`);
                    const response: ErrorResponse = { error };
                    respondWithError(res, 500, response);
                    return;
                }

                try {
                    if (authorization.testRunSessionLease) {
                        testRunSessionLeaseIdByRunId.set(runId, authorization.testRunSessionLease.id);
                    }

                    const config = await createDebugSessionConfiguration(
                        aspireDebugSession?.configuration ?? { type: 'aspire', request: 'launch', name: 'Aspire test run', program: '' },
                        launchConfig,
                        payload.args,
                        payload.env ?? [],
                        { debug: launchConfig.mode === "Debug", runId, debugSessionId: dcpId, isApphost: false, debugSession: aspireDebugSession ?? undefined },
                        foundDebuggerExtension
                    );

                    const resourceDebugSession = aspireDebugSession
                        ? await aspireDebugSession.startAndGetDebugSession(config)
                        : await startAndGetDebugSession(config, dcpServerInstance);

                    if (!resourceDebugSession) {
                        // Clean up any processes associated with this run (registered by resource-type extensions)
                        cleanupRun(runId);
                        testRunSessionLeaseIdByRunId.delete(runId);

                        const error: ErrorDetails = {
                            code: 'DebugSessionFailed',
                            message: `Failed to start debug session for run ID ${runId}`,
                            details: []
                        };

                        extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${error.message}`);
                        const response: ErrorResponse = { error };
                        respondWithError(res, 500, response);
                        return;
                    }

                    if (authorization.testRunSessionLease && !testRunSessionManager?.isActive(authorization.testRunSessionLease.id)) {
                        await resourceDebugSession.stopSession();
                        testRunSessionLeaseIdByRunId.delete(runId);

                        const error: ErrorDetails = {
                            code: 'TestRunSessionReleased',
                            message: 'The Aspire test run session was released before the resource debug session started.',
                            details: []
                        };

                        extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${error.message}`);
                        const response: ErrorResponse = { error };
                        respondWithError(res, 410, response);
                        return;
                    }

                    processes.push(resourceDebugSession);
                    extensionLogOutputChannel.info(`Debugging session created with ID: ${runId}`);

                    runsBySession.set(runId, processes);

                    res.status(201).set('Location', `https://${req.get('host')}/run_session/${runId}`).end();
                    extensionLogOutputChannel.info(`New run session created with ID: ${runId}`);
                } catch (err) {
                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${err}`);

                    // Clean up any processes associated with this run (registered by resource-type extensions)
                    cleanupRun(runId);
                    testRunSessionLeaseIdByRunId.delete(runId);

                    // Notify DCP via WebSocket that the session terminated so it can update
                    // resource state, AND respond with HTTP 500 so the original POST /run_session
                    // request gets a proper error. Both are needed: the 500 tells DCP the launch
                    // failed synchronously, while sessionTerminated handles async cleanup.
                    const notification: SessionTerminatedNotification = {
                        notification_type: 'sessionTerminated',
                        session_id: runId,
                        dcp_id: dcpId,
                        exit_code: -1
                    };

                    const ws = wsBySession.get(dcpId);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        AspireDcpServer.sendNotificationCore(notification, ws);
                    } else {
                        pendingNotificationQueueByDcpId.set(dcpId, [...(pendingNotificationQueueByDcpId.get(dcpId) || []), notification]);
                    }

                    const error: ErrorDetails = {
                        code: 'DebugSessionFailed',
                        message: `Failed to start debug session for run ID ${runId}: ${err instanceof Error ? err.message : String(err)}`,
                        details: []
                    };

                    const response: ErrorResponse = { error };
                    respondWithError(res, 500, response);
                }
            });

            app.delete('/run_session/:id', requireHeaders, async (req: Request, res: Response) => {
                const runId = req.params.id as string;
                const authorization = (req as Request & { aspireDcpAuthorization: AuthorizedDcpRequest }).aspireDcpAuthorization;
                if (runsBySession.has(runId)) {
                    if (authorization.testRunSessionLease && testRunSessionLeaseIdByRunId.get(runId) !== authorization.testRunSessionLease.id) {
                        res.status(404).end();
                        return;
                    }

                    await dcpServerInstance?.stopRunSession(runId);
                    res.status(200).end();
                } else {
                    res.status(204).end();
                }
            });


            const { key, cert, certBase64 } = await createSelfSignedCertAsync();
            const server = https.createServer({ key, cert }, app);
            const wss = new WebSocketServer({ noServer: true });

            server.on('upgrade', (request, socket, head) => {
                if (request.url?.startsWith('/run_session/notify')) {
                    const authorization = authorizeDcpRequest(request.headers.authorization, request.headers['microsoft-developer-dcp-instance-id'] as string | undefined);
                    if (!authorization || typeof authorization === 'string') {
                        socket.destroy();
                        return;
                    }

                    wss.handleUpgrade(request, socket, head, (ws) => {
                        const dcpId = authorization.dcpId;
                        extensionLogOutputChannel.info(`WebSocket connection established for DCP ID: ${dcpId}`);
                        wsBySession.set(dcpId, ws);

                        const pendingNotifications = pendingNotificationQueueByDcpId.get(dcpId);
                        if (pendingNotifications) {
                            for (const notification of pendingNotifications) {
                                AspireDcpServer.sendNotificationCore(notification, ws);
                            }

                            pendingNotificationQueueByDcpId.delete(dcpId);
                        }

                        ws.onclose = () => {
                            extensionLogOutputChannel.info(`WebSocket connection closed for DCP ID: ${dcpId}`);
                            wsBySession.delete(dcpId);
                        };
                    });
                } else {
                    socket.destroy();
                }
            });

            wss.on('connection', (ws: WebSocket) => {
                ws.send(JSON.stringify({ notification_type: 'connected' }) + '\n');
            });

            wss.on('message', (data) => {
                extensionLogOutputChannel.info(`Received message from WebSocket client: ${data}`);
            });

            server.listen(0, () => {
                const addr = server.address();
                if (typeof addr === 'object' && addr) {
                    extensionLogOutputChannel.info(`DCP server listening on port ${addr.port} (HTTPS)`);
                    const info: DcpServerConnectionInfo = {
                        address: `localhost:${addr.port}`,
                        token: token,
                        certificate: certBase64
                    };
                    testRunSessionManager = new TestRunSessionManager(info);
                    dcpServerInstance = new AspireDcpServer(info, app, server, wss, runsBySession, testRunSessionLeaseIdByRunId, wsBySession, pendingNotificationQueueByDcpId, testRunSessionManager);
                    resolve(dcpServerInstance);
                } else {
                    reject(new Error('Failed to get server address'));
                }
            });

            server.on('error', reject);
        });
    }

    acquireTestRunSession(options: TestRunSessionAcquireOptions): AcquiredTestRunSession {
        return this.testRunSessionManager.acquire(options);
    }

    async releaseTestRunSession(id: string): Promise<void> {
        const lease = this.testRunSessionManager.release(id);
        const stopSessionPromises: Promise<void>[] = [];
        for (const [runId, leaseId] of this.testRunSessionLeaseIdByRunId) {
            if (leaseId === id) {
                stopSessionPromises.push(this.stopRunSession(runId));
            }
        }

        if (lease) {
            this.closeLeaseNotificationConnections(lease);
        }

        await Promise.all(stopSessionPromises);
    }

    sendNotification(notification: RunSessionNotification) {
        // If no WebSocket is available for the session, log a warning
        const ws = this.wsBySession.get(notification.dcp_id);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            extensionLogOutputChannel.trace(`No WebSocket found for DCP ID: ${notification.dcp_id} or WebSocket is not open (state: ${ws?.readyState})`);
            this.pendingNotificationQueueByDcpId.set(notification.dcp_id, [...(this.pendingNotificationQueueByDcpId.get(notification.dcp_id) || []), notification]);
            return;
        }

        AspireDcpServer.sendNotificationCore(notification, ws);
    }

    static sendNotificationCore(notification: RunSessionNotification, ws: WebSocket) {
        // Send the notification to the WebSocket
        if (notification.notification_type === 'processRestarted') {
            const processNotification = notification as ProcessRestartedNotification;
            const message = JSON.stringify({
                notification_type: 'processRestarted',
                session_id: notification.session_id,
                pid: processNotification.pid
            });

            ws.send(message + '\n');
        }
        else if (notification.notification_type === 'sessionTerminated') {
            const sessionTerminated = notification as SessionTerminatedNotification;
            const message = JSON.stringify({
                notification_type: 'sessionTerminated',
                session_id: notification.session_id,
                exit_code: sessionTerminated.exit_code
            });

            ws.send(message + '\n');
        }
        else if (notification.notification_type === 'serviceLogs') {
            const serviceLogs = notification as ServiceLogsNotification;
            const message = JSON.stringify({
                notification_type: 'serviceLogs',
                session_id: notification.session_id,
                is_std_err: serviceLogs.is_std_err,
                log_message: serviceLogs.log_message
            });

            ws.send(message + '\n');
        }
    }

    private async stopRunSession(runId: string): Promise<void> {
        const baseDebugSessions = this.runsBySession.get(runId);
        for (const debugSession of baseDebugSessions || []) {
            await debugSession.stopSession();
        }

        this.runsBySession.delete(runId);
        this.testRunSessionLeaseIdByRunId.delete(runId);
    }

    ensureDebugAdapterTracker(debugAdapter: string): void {
        if (this.debugAdapterTrackerDisposablesByAdapter.has(debugAdapter)) {
            return;
        }

        this.debugAdapterTrackerDisposablesByAdapter.set(debugAdapter, createDebugAdapterTracker(this, debugAdapter));
    }

    private closeLeaseNotificationConnections(lease: TestRunSessionLease): void {
        const prefix = `${lease.sessionId}-`;
        for (const [dcpId, ws] of this.wsBySession) {
            if (dcpId.startsWith(prefix)) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1000, 'Test run session released');
                }

                this.wsBySession.delete(dcpId);
            }
        }

        for (const dcpId of this.pendingNotificationQueueByDcpId.keys()) {
            if (dcpId.startsWith(prefix)) {
                this.pendingNotificationQueueByDcpId.delete(dcpId);
            }
        }
    }

    public dispose(): void {
        for (const runId of [...this.runsBySession.keys()]) {
            void this.stopRunSession(runId);
        }

        this.testRunSessionLeaseIdByRunId.clear();
        this.pendingNotificationQueueByDcpId.clear();
        for (const disposable of this.debugAdapterTrackerDisposablesByAdapter.values()) {
            disposable.dispose();
        }

        this.debugAdapterTrackerDisposablesByAdapter.clear();

        // Send WebSocket close message to all clients before shutting down
        if (this.wss) {
            this.wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.close(1000, 'DCP server shutting down');
                }
            });
            this.wss.close();
        }

        if (this.server) {
            this.server.close();
        }
    }
}

async function startAndGetDebugSession(debugConfig: vscode.DebugConfiguration, dcpServer: AspireDcpServer | undefined): Promise<AspireResourceDebugSession | undefined> {
    dcpServer?.ensureDebugAdapterTracker(debugConfig.type);

    return new Promise((resolve, reject) => {
        let completed = false;
        let timeout: NodeJS.Timeout | undefined;
        let lateCleanupTimeout: NodeJS.Timeout | undefined;
        const disposable = vscode.debug.onDidStartDebugSession(session => {
            if (session.configuration.runId === debugConfig.runId) {
                if (completed) {
                    void vscode.debug.stopDebugging(session);
                    cleanupRun(debugConfig.runId);
                    disposable.dispose();
                    if (lateCleanupTimeout) {
                        clearTimeout(lateCleanupTimeout);
                    }

                    return;
                }

                complete({
                    id: session.id,
                    session,
                    stopSession: async () => {
                        await vscode.debug.stopDebugging(session);
                        cleanupRun(debugConfig.runId);
                    }
                });
            }
        });

        function complete(result: AspireResourceDebugSession | undefined): void {
            if (completed) {
                return;
            }

            completed = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            if (lateCleanupTimeout) {
                clearTimeout(lateCleanupTimeout);
            }

            disposable.dispose();
            resolve(result);
        }

        timeout = setTimeout(() => {
            completed = true;
            resolve(undefined);
            lateCleanupTimeout = setTimeout(() => {
                disposable.dispose();
            }, 60_000);
        }, 10000);

        vscode.debug.startDebugging(undefined, debugConfig).then(started => {
            if (!started) {
                complete(undefined);
            }
        }, err => {
            if (completed) {
                return;
            }

            completed = true;
            if (timeout) {
                clearTimeout(timeout);
            }

            disposable.dispose();
            reject(err);
        });
    });
}

export function generateRunId(): string {
    return `run-${Math.random().toString(36).substring(2, 15)}`;
}

export function generateDcpIdPrefix(): string {
    return `aspire-extension-run-${Math.random().toString(36).substring(2, 15)}`;
}

function getDcpIdPrefix(dcpId: string): string | null {
    const regex = /^(aspire-extension-run-[a-z0-9]+)-.+$/;
    if (regex.test(dcpId)) {
        return dcpId.match(regex)![1];
    }

    return null;
}

function respondWithError(res: Response, statusCode: number, message: ErrorResponse): void {
    res.status(statusCode).json(message).end();
    vscode.window.showErrorMessage(encounteredErrorStartingResource(message.error.message));
}

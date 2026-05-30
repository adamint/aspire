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
import { timingSafeEqual } from 'crypto';
import { getRunSessionInfo, getSupportedCapabilities } from '../capabilities';
import { authorizationAndDcpHeadersRequired, authorizationHeaderMustStartWithBearer, encounteredErrorStartingResource, invalidOrMissingToken, invalidTokenLength } from '../loc/strings';
import { DashboardTelemetryPassthrough } from './DashboardTelemetryPassthrough';
import { isExtensionTelemetryEnabled, sendTelemetryErrorEvent, sendTelemetryEvent } from '../utils/telemetry';

/**
 * Callbacks the DCP server invokes for cross-cutting telemetry concerns.
 * Kept as an interface so the constructor stays narrow and so tests can
 * supply no-op implementations.
 */
export interface DcpTelemetryHooks {
    /**
     * Called whenever a `PUT /run_session` request is accepted, regardless of
     * whether the underlying debugger extension launch succeeds. Used by the
     * meaningful-engagement reporter to count any external debug activation
     * as engagement.
     */
    onRunSessionAccepted?: (info: { resourceType: string; mode: string }) => void;
}

export default class AspireDcpServer {
    private readonly app: express.Express;
    private server: https.Server;
    private wss: WebSocketServer;
    private wsBySession: Map<string, WebSocket> = new Map();
    private pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]> = new Map();
    private readonly _dashboardTelemetry: DashboardTelemetryPassthrough;
    // Per-runId metadata for telemetry correlation between PUT /run_session and
    // the subsequent sessionTerminated WebSocket notification. We need to look
    // up the original event timing/labels when the session terminates, since
    // the WebSocket notification arrives without that context.
    private readonly _runTelemetryById: Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>;
    // Per AppHost debug-session aggregate stats accumulated across the lifetime of the
    // session. Used to emit the `debug/appHost/end` summary when an AppHost debug session
    // terminates. Entries are added on first run_session for a debugSessionId and removed
    // (and returned) by takeDebugSessionAggregateStats().
    private readonly _debugSessionStats: Map<string, { totalChildSessions: number; distinctResourceTypes: Set<string>; anyNonZeroExit: boolean }>;

    public readonly connectionInfo: DcpServerConnectionInfo;

    private constructor(
        info: DcpServerConnectionInfo,
        app: express.Express,
        server: https.Server,
        wss: WebSocketServer,
        wsBySession: Map<string, WebSocket>,
        pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]>,
        dashboardTelemetry: DashboardTelemetryPassthrough,
        runTelemetryById: Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>,
        debugSessionStats: Map<string, { totalChildSessions: number; distinctResourceTypes: Set<string>; anyNonZeroExit: boolean }>) {
        this.connectionInfo = info;
        this.app = app;
        this.server = server;
        this.wss = wss;
        this.wsBySession = wsBySession;
        this.pendingNotificationQueueByDcpId = pendingNotificationQueueByDcpId;
        this._dashboardTelemetry = dashboardTelemetry;
        this._runTelemetryById = runTelemetryById;
        this._debugSessionStats = debugSessionStats;
    }

    /**
     * Returns and clears accumulated per-AppHost-debug-session telemetry stats for the
     * given debug session id. Called from AspireDebugSession.dispose() to emit the
     * `debug/appHost/end` summary event. Returns undefined if no run_session was ever
     * accepted for this debug session.
     */
    takeDebugSessionAggregateStats(debugSessionId: string): { totalChildSessions: number; distinctResourceTypes: string[]; anyNonZeroExit: boolean } | undefined {
        const stats = this._debugSessionStats.get(debugSessionId);
        if (!stats) {
            return undefined;
        }
        this._debugSessionStats.delete(debugSessionId);
        return {
            totalChildSessions: stats.totalChildSessions,
            distinctResourceTypes: Array.from(stats.distinctResourceTypes).sort(),
            anyNonZeroExit: stats.anyNonZeroExit,
        };
    }

    static async create(getDebugSession: (debugSessionId: string) => AspireDebugSession | null, hooks: DcpTelemetryHooks = {}): Promise<AspireDcpServer> {
        const runsBySession = new Map<string, AspireResourceDebugSession[]>();
        const runTelemetryById = new Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>();
        const debugSessionStats = new Map<string, { totalChildSessions: number; distinctResourceTypes: Set<string>; anyNonZeroExit: boolean }>();
        const wsBySession = new Map<string, WebSocket>();
        const pendingNotificationQueueByDcpId = new Map<string, RunSessionNotification[]>();
        const dashboardTelemetry = new DashboardTelemetryPassthrough();

        return new Promise(async (resolve, reject) => {
            const token = generateToken();

            const app = express();
            app.use(express.json());

            function requireHeaders(req: Request, res: Response, next: NextFunction): void {
                const auth = req.header('Authorization');
                const dcpId = req.header('microsoft-developer-dcp-instance-id');
                if (!auth || !dcpId) {
                    respondWithError(res, 401, { error: { code: 'MissingHeaders', message: authorizationAndDcpHeadersRequired, details: [] } });
                    return;
                }

                if (auth.split('Bearer ').length !== 2) {
                    respondWithError(res, 401, { error: { code: 'InvalidAuthHeader', message: authorizationHeaderMustStartWithBearer, details: [] } });
                    return;
                }

                const bearerTokenBuffer = Buffer.from(auth.split('Bearer ')[1]);
                const expectedTokenBuffer = Buffer.from(token);

                if (bearerTokenBuffer.length !== expectedTokenBuffer.length) {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidTokenLength, details: [] } });
                    return;
                }

                // timingSafeEqual is used to verify that the tokens are equivalent in a way that mitigates timing attacks
                if (timingSafeEqual(bearerTokenBuffer, expectedTokenBuffer) === false) {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidOrMissingToken, details: [] } });
                    return;
                }

                next();
            }

            // The dashboard's telemetry pipeline calls /telemetry/* with only
            // the bearer token (Authorization header) — it does not carry a
            // DCP instance id because the dashboard does not participate in
            // run_session orchestration. This middleware enforces the same
            // bearer token as requireHeaders but skips the DCP id check.
            // See `Aspire.Dashboard/Model/DebugSessionHelpers.cs` (CreateHttpClient).
            function requireBearerOnly(req: Request, res: Response, next: NextFunction): void {
                const auth = req.header('Authorization');
                if (!auth) {
                    respondWithError(res, 401, { error: { code: 'MissingHeaders', message: authorizationAndDcpHeadersRequired, details: [] } });
                    return;
                }
                if (auth.split('Bearer ').length !== 2) {
                    respondWithError(res, 401, { error: { code: 'InvalidAuthHeader', message: authorizationHeaderMustStartWithBearer, details: [] } });
                    return;
                }
                const bearerTokenBuffer = Buffer.from(auth.split('Bearer ')[1]);
                const expectedTokenBuffer = Buffer.from(token);
                if (bearerTokenBuffer.length !== expectedTokenBuffer.length) {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidTokenLength, details: [] } });
                    return;
                }
                if (timingSafeEqual(bearerTokenBuffer, expectedTokenBuffer) === false) {
                    respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidOrMissingToken, details: [] } });
                    return;
                }
                next();
            }

            // Dashboard telemetry passthrough — mounts /telemetry/* including
            // the /telemetry/enabled handshake. Replaces the old hardcoded
            // is_enabled:false response so the dashboard's telemetry pipeline
            // can finally talk to the extension's reporter.
            dashboardTelemetry.register(app, requireBearerOnly);

            app.get('/info', (req: Request, res: Response) => {
                res.json(getRunSessionInfo());
            });

            app.put('/run_session', requireHeaders, async (req: Request, res: Response) => {
                const payload: RunSessionPayload = req.body;
                const runId = generateRunId();
                const dcpId = req.header('microsoft-developer-dcp-instance-id') as string;
                const debugSessionId = getDcpIdPrefix(dcpId);
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
                const mode = launchConfig.mode ?? 'Unknown';
                // Emit early — even unsupported resource types count as engagement
                // because the user did try to run something through us.
                hooks.onRunSessionAccepted?.({ resourceType: launchConfig.type, mode });
                sendTelemetryEvent('debug/runSession/start', {
                    resource_type: launchConfig.type,
                    debugger_extension_matched: foundDebuggerExtension ? 'true' : 'false',
                    mode,
                });

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
                if (!aspireDebugSession) {
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
                    const config = await createDebugSessionConfiguration(
                        aspireDebugSession.configuration,
                        launchConfig,
                        payload.args,
                        payload.env ?? [],
                        { debug: launchConfig.mode === "Debug", runId, debugSessionId: dcpId, isApphost: false, debugSession: aspireDebugSession },
                        foundDebuggerExtension
                    );

                    const resourceDebugSession = await aspireDebugSession.startAndGetDebugSession(config);

                    if (!resourceDebugSession) {
                        // Clean up any processes associated with this run (registered by resource-type extensions)
                        cleanupRun(runId);

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

                    processes.push(resourceDebugSession);
                    extensionLogOutputChannel.info(`Debugging session created with ID: ${runId}`);

                    runsBySession.set(runId, processes);
                    runTelemetryById.set(runId, { startTimeMs: Date.now(), resourceType: launchConfig.type, mode, debugSessionId });

                    // Track aggregate stats for the parent AppHost debug session so we can
                    // emit a single `debug/appHost/end` summary when the AppHost terminates.
                    let aggregate = debugSessionStats.get(debugSessionId);
                    if (!aggregate) {
                        aggregate = { totalChildSessions: 0, distinctResourceTypes: new Set<string>(), anyNonZeroExit: false };
                        debugSessionStats.set(debugSessionId, aggregate);
                    }
                    aggregate.totalChildSessions += 1;
                    aggregate.distinctResourceTypes.add(launchConfig.type);

                    res.status(201).set('Location', `https://${req.get('host')}/run_session/${runId}`).end();
                    extensionLogOutputChannel.info(`New run session created with ID: ${runId}`);
                } catch (err) {
                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${err}`);

                    // Track in aggregate AppHost-debug-session stats even for synchronous
                    // launch failures so the eventual `debug/appHost/end` summary reflects
                    // them.
                    let aggregateOnFailure = debugSessionStats.get(debugSessionId);
                    if (!aggregateOnFailure) {
                        aggregateOnFailure = { totalChildSessions: 0, distinctResourceTypes: new Set<string>(), anyNonZeroExit: false };
                        debugSessionStats.set(debugSessionId, aggregateOnFailure);
                    }
                    aggregateOnFailure.totalChildSessions += 1;
                    aggregateOnFailure.distinctResourceTypes.add(launchConfig.type);
                    aggregateOnFailure.anyNonZeroExit = true;

                    // Synchronous launch failure — emit the end event immediately
                    // since no sessionTerminated will be observed downstream.
                    sendTelemetryErrorEvent('debug/runSession/end', {
                        resource_type: launchConfig.type,
                        mode,
                        exit_code_bucket: 'nonzero',
                        end_reason: 'launch_failed',
                        error_kind: err instanceof Error ? err.name || 'Error' : typeof err,
                    }, {
                        duration_ms: 0,
                    });

                    // Clean up any processes associated with this run (registered by resource-type extensions)
                    cleanupRun(runId);

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
                if (runsBySession.has(runId)) {
                    const baseDebugSessions = runsBySession.get(runId);
                    for (const debugSession of baseDebugSessions || []) {
                        debugSession.stopSession();
                    }

                    runsBySession.delete(runId);
                    // Map cleanup happens when the corresponding sessionTerminated
                    // notification is sent; don't pre-delete here or we'd miss the
                    // end event.
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
                    wss.handleUpgrade(request, socket, head, (ws) => {
                        const dcpId = request.headers['microsoft-developer-dcp-instance-id'] as string;
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
                    resolve(new AspireDcpServer(info, app, server, wss, wsBySession, pendingNotificationQueueByDcpId, dashboardTelemetry, runTelemetryById, debugSessionStats));
                } else {
                    reject(new Error('Failed to get server address'));
                }
            });

            server.on('error', reject);
        });
    }

    sendNotification(notification: RunSessionNotification) {
        // Emit a telemetry end event for session termination, regardless of
        // whether the WebSocket is currently connected. We do this here (and
        // not at the WebSocket-send call site) because every termination path
        // goes through sendNotification — the synchronous launch-failure path
        // in PUT /run_session goes through sendNotificationCore directly, and
        // already emits its own end event from the catch block.
        if (notification.notification_type === 'sessionTerminated') {
            const sessionTerminated = notification as SessionTerminatedNotification;
            const entry = this._runTelemetryById.get(notification.session_id);
            if (entry) {
                this._runTelemetryById.delete(notification.session_id);
                const durationMs = Date.now() - entry.startTimeMs;
                const exitCode = sessionTerminated.exit_code;
                const exitBucket = exitCode === 0 ? 'success' : exitCode === -1 ? 'canceled' : 'nonzero';
                sendTelemetryEvent('debug/runSession/end', {
                    resource_type: entry.resourceType,
                    mode: entry.mode,
                    exit_code_bucket: exitBucket,
                }, {
                    duration_ms: durationMs,
                    exit_code: exitCode,
                });

                // Surface a non-zero exit on the parent AppHost debug-session aggregate so
                // the eventual `debug/appHost/end` summary reflects whether any child
                // resource session ended unsuccessfully.
                if (exitBucket === 'nonzero') {
                    const aggregate = this._debugSessionStats.get(entry.debugSessionId);
                    if (aggregate) {
                        aggregate.anyNonZeroExit = true;
                    }
                }
            }
        }

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

    public dispose(): void {
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

        this._dashboardTelemetry.dispose();
    }
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

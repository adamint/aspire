import express, { Request, Response, NextFunction } from 'express';
import https from 'https';
import WebSocket, { WebSocketServer } from 'ws';
import * as vscode from 'vscode';
import { createSelfSignedCertAsync, generateToken } from '../utils/security';
import { extensionLogOutputChannel } from '../utils/logging';
import { AspireResourceDebugSession, DcpServerConnectionInfo, ErrorDetails, ErrorResponse, ProcessRestartedNotification, RunSessionNotification, RunSessionPayload, ServiceLogsNotification, SessionMessageNotification, SessionTerminatedNotification } from './types';
import { AspireDebugSession } from '../debugger/AspireDebugSession';
import { getResourceDebuggerExtensions, prepareDebugSession } from '../debugger/debuggerExtensions';
import { cleanupRun } from '../debugger/runCleanupRegistry';
import { timingSafeEqual, randomBytes } from 'crypto';
import { getRunSessionInfo, getSupportedCapabilities } from '../capabilities';
import { authorizationAndDcpHeadersRequired, authorizationHeaderMustStartWithBearer, authorizationHeaderRequired, encounteredErrorStartingResource, invalidOrMissingToken, invalidTokenLength } from '../loc/strings';
import { DashboardTelemetryPassthrough } from './DashboardTelemetryPassthrough';
import { classifyError, sendTelemetryErrorEvent, sendTelemetryEvent } from '../utils/telemetry';

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

interface DcpServerOptions {
    requestedStopTelemetryTimeoutMs?: number;
    terminalStateRetentionMs?: number;
}

type DebugSessionAggregateStats = {
    totalChildSessions: number;
    distinctResourceTypes: Set<string>;
    anyNonZeroExit: boolean;
};

type RunSessionState = {
    adapterCompletionProcessed: boolean;
    debugSessions: AspireResourceDebugSession[];
    lifecycle: 'starting' | 'running' | 'stopRequested' | 'completed';
    ownerDcpId: string;
    runId: string;
    teardownStarted: boolean;
    telemetryFallbackTimer?: NodeJS.Timeout;
    terminalStateTimer?: NodeJS.Timeout;
    terminalNotificationSent: boolean;
};

export default class AspireDcpServer {
    private readonly app: express.Express;
    private server: https.Server;
    private wss: WebSocketServer;
    private wsBySession: Map<string, WebSocket> = new Map();
    private pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]> = new Map();
    private readonly _dashboardTelemetry: DashboardTelemetryPassthrough;
    private readonly _runsBySession: Map<string, RunSessionState>;
    private _disposed = false;
    // Per-runId metadata for telemetry correlation between PUT /run_session and
    // the subsequent sessionTerminated WebSocket notification. We need to look
    // up the original event timing/labels when the session terminates, since
    // the WebSocket notification arrives without that context.
    private readonly _runTelemetryById: Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>;
    // Per AppHost debug-session aggregate stats accumulated across the lifetime of the
    // session. Used to emit the `debug/apphost/end` summary when an AppHost debug session
    // terminates. Entries are added on first run_session for a debugSessionId and removed
    // (and returned) by takeDebugSessionAggregateStats().
    private readonly _debugSessionStats: Map<string, DebugSessionAggregateStats>;
    private readonly _requestedStopTelemetryTimeoutMs: number;
    private readonly _telemetryFallbackTimers = new Set<NodeJS.Timeout>();
    private readonly _terminalStateRetentionMs: number;
    private readonly _terminalStateTimers = new Set<NodeJS.Timeout>();

    public readonly connectionInfo: DcpServerConnectionInfo;

    private constructor(
        info: DcpServerConnectionInfo,
        app: express.Express,
        server: https.Server,
        wss: WebSocketServer,
        wsBySession: Map<string, WebSocket>,
        pendingNotificationQueueByDcpId: Map<string, RunSessionNotification[]>,
        dashboardTelemetry: DashboardTelemetryPassthrough,
        runsBySession: Map<string, RunSessionState>,
        runTelemetryById: Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>,
        debugSessionStats: Map<string, DebugSessionAggregateStats>,
        requestedStopTelemetryTimeoutMs: number,
        terminalStateRetentionMs: number) {
        this.connectionInfo = info;
        this.app = app;
        this.server = server;
        this.wss = wss;
        this.wsBySession = wsBySession;
        this.pendingNotificationQueueByDcpId = pendingNotificationQueueByDcpId;
        this._dashboardTelemetry = dashboardTelemetry;
        this._runsBySession = runsBySession;
        this._runTelemetryById = runTelemetryById;
        this._debugSessionStats = debugSessionStats;
        this._requestedStopTelemetryTimeoutMs = requestedStopTelemetryTimeoutMs;
        this._terminalStateRetentionMs = terminalStateRetentionMs;
    }

    /**
     * Returns and clears accumulated per-AppHost-debug-session telemetry stats for the
     * given debug session id. Called from AspireDebugSession.dispose() to emit the
     * `debug/apphost/end` summary event. Returns undefined if no run_session was ever
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

    recordAppHostProcessExit(debugSessionId: string, exitCode: number | null): void {
        if (exitCode === 0 || exitCode === null) {
            return;
        }

        const stats = this._getOrCreateDebugSessionStats(debugSessionId);
        stats.anyNonZeroExit = true;
    }

    private _getOrCreateDebugSessionStats(debugSessionId: string): DebugSessionAggregateStats {
        let stats = this._debugSessionStats.get(debugSessionId);
        if (!stats) {
            stats = { totalChildSessions: 0, distinctResourceTypes: new Set<string>(), anyNonZeroExit: false };
            this._debugSessionStats.set(debugSessionId, stats);
        }

        return stats;
    }

    static async create(
        getDebugSession: (debugSessionId: string) => AspireDebugSession | null,
        hooks: DcpTelemetryHooks = {},
        options: DcpServerOptions = {}): Promise<AspireDcpServer> {
        const requestedStopTelemetryTimeoutMs = options.requestedStopTelemetryTimeoutMs ?? 5_000;
        const terminalStateRetentionMs = options.terminalStateRetentionMs ?? 5_000;
        const runsBySession = new Map<string, RunSessionState>();
        const runTelemetryById = new Map<string, { startTimeMs: number; resourceType: string; mode: string; debugSessionId: string }>();
        const debugSessionStats = new Map<string, DebugSessionAggregateStats>();
        const getOrCreateDebugSessionStats = (debugSessionId: string): DebugSessionAggregateStats => {
            let aggregate = debugSessionStats.get(debugSessionId);
            if (!aggregate) {
                aggregate = { totalChildSessions: 0, distinctResourceTypes: new Set<string>(), anyNonZeroExit: false };
                debugSessionStats.set(debugSessionId, aggregate);
            }

            return aggregate;
        };
        const wsBySession = new Map<string, WebSocket>();
        const pendingNotificationQueueByDcpId = new Map<string, RunSessionNotification[]>();
        const dashboardTelemetry = new DashboardTelemetryPassthrough();
        let dcpServer: AspireDcpServer;

        return new Promise(async (resolve, reject) => {
            const token = generateToken();

            const app = express();
            app.use(express.json());

            // Validates an HTTP Authorization header of the form
            //   Authorization: Bearer <token>
            // per RFC 6750 §2.1. Returns a discriminated result describing
            // which validation step failed. Factored out so the two middlewares
            // below share identical parsing semantics (the prior
            // `.split('Bearer ').length === 2` check accepted other schemes
            // that happened to contain `Bearer ` as a substring, e.g.
            // `X-Bearer <token>`).
            const BEARER_PREFIX = 'Bearer ';
            function validateBearerToken(auth: string | undefined):
                | { kind: 'ok' }
                | { kind: 'missing' }
                | { kind: 'invalid_scheme' }
                | { kind: 'invalid_length' }
                | { kind: 'invalid_token' } {
                if (!auth) {
                    return { kind: 'missing' };
                }
                if (!auth.startsWith(BEARER_PREFIX) || auth.length === BEARER_PREFIX.length) {
                    return { kind: 'invalid_scheme' };
                }
                const candidateToken = Buffer.from(auth.slice(BEARER_PREFIX.length));
                const expectedToken = Buffer.from(token);
                if (candidateToken.length !== expectedToken.length) {
                    return { kind: 'invalid_length' };
                }
                // timingSafeEqual is used to verify that the tokens are equivalent in a way that mitigates timing attacks
                if (timingSafeEqual(candidateToken, expectedToken) === false) {
                    return { kind: 'invalid_token' };
                }
                return { kind: 'ok' };
            }

            // `validateBearerToken` only returns 'missing' when the Authorization
            // header is absent; the requireHeaders path catches that case inline
            // (with the combined message) before calling validateBearerToken.
            // Keep this helper Authorization-only for DCP endpoints that already
            // performed their own DCP instance-id validation.
            function respondToBearerFailure(res: Response, kind: 'missing' | 'invalid_scheme' | 'invalid_length' | 'invalid_token'): void {
                switch (kind) {
                    case 'missing':
                        respondWithError(res, 401, { error: { code: 'MissingHeaders', message: authorizationHeaderRequired, details: [] } });
                        return;
                    case 'invalid_scheme':
                        respondWithError(res, 401, { error: { code: 'InvalidAuthHeader', message: authorizationHeaderMustStartWithBearer, details: [] } });
                        return;
                    case 'invalid_length':
                        respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidTokenLength, details: [] } });
                        return;
                    case 'invalid_token':
                        respondWithError(res, 401, { error: { code: 'InvalidToken', message: invalidOrMissingToken, details: [] } });
                        return;
                }
            }

            function requireHeaders(req: Request, res: Response, next: NextFunction): void {
                const auth = req.header('Authorization');
                const dcpId = req.header('microsoft-developer-dcp-instance-id');
                if (!auth || !dcpId) {
                    respondWithError(res, 401, { error: { code: 'MissingHeaders', message: authorizationAndDcpHeadersRequired, details: [] } });
                    return;
                }

                const result = validateBearerToken(auth);
                if (result.kind !== 'ok') {
                    respondToBearerFailure(res, result.kind);
                    return;
                }

                next();
            }

            function respondWithTelemetryAuthError(res: Response, statusCode: number, code: string, message: string): void {
                res.status(statusCode).json({ error: { code, message, details: [] } }).end();
            }

            function respondToTelemetryBearerFailure(res: Response, kind: 'missing' | 'invalid_scheme' | 'invalid_length' | 'invalid_token'): void {
                switch (kind) {
                    case 'missing':
                        respondWithTelemetryAuthError(res, 401, 'MissingHeaders', authorizationAndDcpHeadersRequired);
                        return;
                    case 'invalid_scheme':
                        respondWithTelemetryAuthError(res, 401, 'InvalidAuthHeader', authorizationHeaderMustStartWithBearer);
                        return;
                    case 'invalid_length':
                        respondWithTelemetryAuthError(res, 401, 'InvalidToken', invalidTokenLength);
                        return;
                    case 'invalid_token':
                        respondWithTelemetryAuthError(res, 401, 'InvalidToken', invalidOrMissingToken);
                        return;
                }
            }

            function requireTelemetryHeaders(req: Request, res: Response, next: NextFunction): void {
                const auth = req.header('Authorization');
                const dcpId = req.header('microsoft-developer-dcp-instance-id');
                if (!auth || !dcpId) {
                    respondWithTelemetryAuthError(res, 401, 'MissingHeaders', authorizationAndDcpHeadersRequired);
                    return;
                }

                const result = validateBearerToken(auth);
                if (result.kind !== 'ok') {
                    respondToTelemetryBearerFailure(res, result.kind);
                    return;
                }

                const debugSessionId = getDcpIdPrefix(dcpId);
                if (!debugSessionId || !getDebugSession(debugSessionId)) {
                    respondWithTelemetryAuthError(res, 401, 'InvalidDcpInstanceId', 'Missing valid DCP prefix corresponding to an Aspire debug session.');
                    return;
                }

                next();
            }

            // Dashboard telemetry passthrough — mounts /telemetry/* including
            // the /telemetry/enabled handshake. Replaces the old hardcoded
            // is_enabled:false response so the dashboard's telemetry pipeline
            // can finally talk to the extension's reporter.
            dashboardTelemetry.register(app, requireTelemetryHeaders);

            // Per the DCP IDE-execution spec, GET /info requires both the
            // bearer token and the DCP instance id. See
            // docs/specs/IDE-execution.md (#ide-endpoint-information-request).
            // Without auth, any local process could enumerate which VS Code
            // language extensions are installed on the user's machine.
            app.get('/info', requireHeaders, (req: Request, res: Response) => {
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
                // Telemetry: clamp `launchConfig.mode` to the known
                // LaunchConfigurationMode values. It originates from the
                // CLI-controlled request body and feeds the `mode` dimension on
                // multiple events; without clamping an arbitrary string would
                // leak verbatim, mirroring the `supportedResourceType` clamp
                // below. `== null` catches both `undefined` and a malformed
                // JSON `null` (preserving the prior `?? 'Unknown'` behavior) and
                // keeps the 'Unknown' bucket; any other unexpected value
                // collapses to 'other'.
                const rawMode = launchConfig.mode;
                const mode = rawMode == null
                    ? 'Unknown'
                    : (rawMode === 'Debug' || rawMode === 'NoDebug' ? rawMode : 'other');
                // Telemetry: clamp `launchConfig.type` to the set of resource types we
                // actually understand. Unsupported types come from
                // `payload.launch_configurations[0].type` which is a CLI-controlled
                // string and could otherwise leak arbitrary content (custom resource
                // type names, typos) into telemetry. The supported set is the
                // discriminator we care about — "did the user run something we know
                // how to debug?" — and one bucket for everything else is enough.
                const supportedResourceType = foundDebuggerExtension ? launchConfig.type : 'unsupported';
                // Emit early — even unsupported resource types count as engagement
                // because the user did try to run something through us.
                hooks.onRunSessionAccepted?.({ resourceType: launchConfig.type, mode });
                const runSessionStartTimeMs = Date.now();
                sendTelemetryEvent('aspire/vscode/debug/runsession/start', {
                    resource_type: supportedResourceType,
                    debugger_extension_matched: foundDebuggerExtension ? 'true' : 'false',
                    mode,
                });

                // Emits a `debug/runsession/end` event paired with the start above and
                // updates the parent AppHost aggregate so failures captured on early-
                // return paths still surface in the `debug/apphost/end` summary. All
                // post-start failure paths in this handler must route through here so
                // we never leave an orphaned start event in the telemetry pipeline.
                const emitRunSessionFailureEnd = (endReason: string, errorKind?: string): void => {
                    runTelemetryById.delete(runId);
                    const aggregate = getOrCreateDebugSessionStats(debugSessionId);
                    aggregate.totalChildSessions += 1;
                    aggregate.distinctResourceTypes.add(supportedResourceType);
                    aggregate.anyNonZeroExit = true;

                    sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
                        resource_type: supportedResourceType,
                        mode,
                        exit_code_bucket: 'nonzero',
                        end_reason: endReason,
                        ...(errorKind ? { error_kind: errorKind } : {}),
                    }, {
                        duration_ms: Date.now() - runSessionStartTimeMs,
                    });
                };

                if (!foundDebuggerExtension) {
                    emitRunSessionFailureEnd('unsupported_launch_config');
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
                    emitRunSessionFailureEnd('debug_session_not_found');
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

                // Reserve the run before starting VS Code's debug session. The debug adapter
                // tracker is created during startup and binds to this object so a late adapter
                // callback can still deduplicate against a requested stop after the map entry
                // has been removed.
                const run: RunSessionState = {
                    adapterCompletionProcessed: false,
                    debugSessions: processes,
                    lifecycle: 'starting',
                    ownerDcpId: dcpId,
                    runId,
                    teardownStarted: false,
                    terminalNotificationSent: false,
                };
                runsBySession.set(runId, run);
                runTelemetryById.set(runId, { startTimeMs: runSessionStartTimeMs, resourceType: supportedResourceType, mode, debugSessionId });

                try {
                    const preparedSession = await prepareDebugSession(
                        aspireDebugSession.configuration,
                        launchConfig,
                        payload.args,
                        payload.env ?? [],
                        { debug: launchConfig.mode === "Debug", runId, debugSessionId: dcpId, isApphost: false, debugSession: aspireDebugSession },
                        foundDebuggerExtension
                    );

                    const resourceDebugSession = preparedSession.alreadyStartedSession
                        ? aspireDebugSession.trackAlreadyStartedResourceSession(preparedSession.debugConfiguration, preparedSession.alreadyStartedSession)
                        : await aspireDebugSession.startAndGetDebugSession(preparedSession.debugConfiguration);

                    if (run.lifecycle !== 'starting') {
                        // DELETE can win while VS Code is still starting the adapter. A late
                        // success belongs to the already-terminated run, so stop it without
                        // publishing it as a live session.
                        if (resourceDebugSession) {
                            try {
                                void Promise.resolve(resourceDebugSession.stopSession()).catch(err => {
                                    extensionLogOutputChannel.warn(`Failed to stop late debug session for run ID ${runId}: ${err instanceof Error ? err.message : String(err)}`);
                                });
                            } catch (err) {
                                extensionLogOutputChannel.warn(`Failed to stop late debug session for run ID ${runId}: ${err instanceof Error ? err.message : String(err)}`);
                            }
                        }
                        cleanupRun(runId);

                        const error: ErrorDetails = {
                            code: 'RunSessionTerminated',
                            message: `Run session ${runId} was terminated while its debug session was starting.`,
                            details: []
                        };
                        res.status(409).json({ error }).end();
                        return;
                    }

                    if (!resourceDebugSession) {
                        runsBySession.delete(runId);
                        emitRunSessionFailureEnd('debugger_did_not_start');

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
                    run.lifecycle = 'running';
                    extensionLogOutputChannel.info(`Debugging session created with ID: ${runId}`);

                    // Track aggregate stats for the parent AppHost debug session so we can
                    // emit a single `debug/apphost/end` summary when the AppHost terminates.
                    const aggregate = getOrCreateDebugSessionStats(debugSessionId);
                    aggregate.totalChildSessions += 1;
                    aggregate.distinctResourceTypes.add(supportedResourceType);

                    res.status(201).set('Location', `https://${req.get('host')}/run_session/${runId}`).end();
                    extensionLogOutputChannel.info(`New run session created with ID: ${runId}`);
                } catch (err) {
                    if (run.lifecycle !== 'starting') {
                        cleanupRun(runId);
                        const error: ErrorDetails = {
                            code: 'RunSessionTerminated',
                            message: `Run session ${runId} was terminated while its debug session was starting.`,
                            details: []
                        };
                        res.status(409).json({ error }).end();
                        return;
                    }

                    extensionLogOutputChannel.error(`Error creating debug session ${runId}: ${err}`);

                    // Synchronous launch failure — emit the matching end event and update
                    // aggregate stats via the shared helper before responding so the eventual
                    // `debug/apphost/end` summary reflects the failure.
                    emitRunSessionFailureEnd('launch_failed', classifyError(err));

                    // Clean up any processes associated with this run (registered by resource-type extensions)
                    cleanupRun(runId);

                    // The HTTP failure and terminal notification are both required, but the
                    // adapter may still report its own exit after startup partially succeeded.
                    // Route the notification through the run state so that late callbacks see
                    // the completed protocol result and cannot publish it a second time.
                    dcpServer._sendTerminalNotification(run, -1);
                    dcpServer._completeRun(run);

                    const error: ErrorDetails = {
                        code: 'DebugSessionFailed',
                        message: `Failed to start debug session for run ID ${runId}: ${err instanceof Error ? err.message : String(err)}`,
                        details: []
                    };

                    const response: ErrorResponse = { error };
                    respondWithError(res, 500, response);
                }
            });

            app.delete('/run_session/:id', requireHeaders, (req: Request, res: Response) => {
                const runId = req.params.id as string;
                const run = runsBySession.get(runId);
                const dcpId = req.header('microsoft-developer-dcp-instance-id') as string;
                const ownerPrefix = run ? getDcpIdPrefix(run.ownerDcpId) : null;
                if (run && ownerPrefix !== null && ownerPrefix === getDcpIdPrefix(dcpId)) {
                    // DCP can restart its per-execution instance while the owning Aspire
                    // debug session remains alive. Route all subsequent notifications to
                    // the replacement execution that successfully claimed the run.
                    run.ownerDcpId = dcpId;
                    if (run.lifecycle === 'stopRequested' || run.lifecycle === 'completed') {
                        res.status(200).end();
                        return;
                    }

                    run.lifecycle = 'stopRequested';
                    dcpServer.sendRequestedStopNotification(run);
                    dcpServer._scheduleTerminalStateCleanup(run);

                    // DCP's DELETE contract is the protocol acknowledgement that the run has
                    // terminated. Complete that contract before entering VS Code debugger
                    // teardown, whose implementation may wait on another extension.
                    res.status(200).end();
                    dcpServer._scheduleDebuggerTeardown(run);
                } else if (run) {
                    const error: ErrorDetails = {
                        code: 'RunSessionOwnerMismatch',
                        message: `Run session ${runId} is owned by a different Aspire debug session.`,
                        details: []
                    };
                    res.status(403).json({ error }).end();
                } else {
                    res.status(204).end();
                }
            });


            const { key, cert, certBase64 } = await createSelfSignedCertAsync();
            const server = https.createServer({ key, cert }, app);
            const wss = new WebSocketServer({ noServer: true });

            server.on('upgrade', (request, socket, head) => {
                if (request.url?.startsWith('/run_session/notify')) {
                    // Per the DCP IDE-execution spec, /run_session/notify
                    // upgrade requires both the bearer token and the DCP
                    // instance id headers. See
                    // docs/specs/IDE-execution.md (#subscribe-to-session-change-notifications-request).
                    //
                    // Without this check, any local actor able to reach our
                    // localhost port could:
                    //   - Subscribe to the notification stream and receive
                    //     `serviceLogs` (stdout/stderr of debugged user
                    //     processes) and `sessionTerminated` notifications
                    //     by guessing or predicting a `dcpId`.
                    //   - Hijack notification delivery for an active debug
                    //     session — `wsBySession.set(dcpId, ws)` below
                    //     replaces any existing entry, so a second connection
                    //     for the same `dcpId` silently steals all future
                    //     notifications from the legitimate DCP client.
                    const authHeader = request.headers['authorization'] as string | undefined;
                    const dcpId = request.headers['microsoft-developer-dcp-instance-id'] as string | undefined;
                    if (!dcpId) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    const authResult = validateBearerToken(authHeader);
                    if (authResult.kind !== 'ok') {
                        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    wss.handleUpgrade(request, socket, head, (ws) => {
                        extensionLogOutputChannel.info(`WebSocket connection established for DCP ID: ${dcpId}`);
                        const previousWs = wsBySession.get(dcpId);
                        wsBySession.set(dcpId, ws);
                        if (previousWs && previousWs !== ws && previousWs.readyState === WebSocket.OPEN) {
                            // Install the replacement before closing the old socket so notifications
                            // emitted by close handlers are routed to the new connection.
                            previousWs.close(1000, 'Replaced by a newer DCP connection.');
                        }

                        const pendingNotifications = pendingNotificationQueueByDcpId.get(dcpId);
                        if (pendingNotifications) {
                            for (const notification of pendingNotifications) {
                                AspireDcpServer.sendNotificationCore(notification, ws);
                            }

                            pendingNotificationQueueByDcpId.delete(dcpId);
                        }

                        ws.onclose = () => {
                            extensionLogOutputChannel.info(`WebSocket connection closed for DCP ID: ${dcpId}`);
                            if (wsBySession.get(dcpId) === ws) {
                                wsBySession.delete(dcpId);
                            }
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

            server.listen(0, 'localhost', () => {
                const addr = server.address();
                if (typeof addr === 'object' && addr) {
                    extensionLogOutputChannel.info(`DCP server listening on port ${addr.port} (HTTPS)`);
                    const info: DcpServerConnectionInfo = {
                        address: `localhost:${addr.port}`,
                        token: token,
                        certificate: certBase64
                    };
                    dcpServer = new AspireDcpServer(info, app, server, wss, wsBySession, pendingNotificationQueueByDcpId, dashboardTelemetry, runsBySession, runTelemetryById, debugSessionStats, requestedStopTelemetryTimeoutMs, terminalStateRetentionMs);
                    resolve(dcpServer);
                } else {
                    reject(new Error('Failed to get server address'));
                }
            });

            server.on('error', reject);
        });
    }

    public createRunSessionNotificationHandler(runId: string): (notification: RunSessionNotification) => void {
        const run = this._runsBySession.get(runId);
        if (!run) {
            // Resource adapters can start after a completed run's bounded tombstone expires.
            // Their callbacks must remain scoped to that run and must never fall through to
            // generic AppHost notification delivery, which would bypass terminal deduplication.
            return () => { };
        }

        // The lookup map retains this state for bounded late tracker registration. Once
        // registered, the tracker keeps the same run-scoped dedupe state until the adapter
        // exits, even after the map tombstone expires.
        return notification => this._handleRunSessionNotification(run, notification);
    }

    public sendNotification(notification: RunSessionNotification): void {
        const run = this._runsBySession.get(notification.session_id);
        if (run) {
            this._handleRunSessionNotification(run, notification);
            return;
        }

        this._sendNotification(notification);
    }

    private sendRequestedStopNotification(run: RunSessionState): void {
        this._sendTerminalNotification(run);
        this._scheduleTelemetryFallback(run);
    }

    private _scheduleTelemetryFallback(run: RunSessionState): void {
        if (run.telemetryFallbackTimer || !this._runTelemetryById.has(run.runId)) {
            return;
        }

        // The DELETE response is a protocol result, not proof that the debug adapter has
        // exited. Keep a bounded window for the adapter's real exit code, then close the
        // telemetry pair as canceled without discarding the separately retained run state.
        const timer = setTimeout(() => {
            this._telemetryFallbackTimers.delete(timer);
            if (run.telemetryFallbackTimer === timer) {
                run.telemetryFallbackTimer = undefined;
            }
            this._recordRunSessionCompletion(run, -1);
        }, this._requestedStopTelemetryTimeoutMs);
        run.telemetryFallbackTimer = timer;
        this._telemetryFallbackTimers.add(timer);
    }

    private _scheduleDebuggerTeardown(run: RunSessionState): void {
        if (run.teardownStarted) {
            return;
        }
        run.teardownStarted = true;

        setImmediate(() => {
            if (this._disposed) {
                return;
            }

            for (const debugSession of run.debugSessions) {
                try {
                    void Promise.resolve(debugSession.stopSession()).catch(error => {
                        this._logDebuggerTeardownFailure(run.runId, error);
                    });
                } catch (error) {
                    this._logDebuggerTeardownFailure(run.runId, error);
                }
            }
        });
    }

    private _logDebuggerTeardownFailure(runId: string, error: unknown): void {
        extensionLogOutputChannel.warn(`Failed to stop debug session for run ID ${runId} after DELETE completed: ${error instanceof Error ? error.message : String(error)}`);
    }

    private _scheduleTerminalStateCleanup(run: RunSessionState): void {
        if (run.terminalStateTimer) {
            return;
        }

        const timer = setTimeout(() => {
            this._terminalStateTimers.delete(timer);
            if (run.terminalStateTimer === timer) {
                run.terminalStateTimer = undefined;
            }
            // Retention is the final lifecycle bound. If no adapter exit or
            // telemetry fallback completed the run first, close telemetry here
            // before removing the only run-scoped state owner.
            this._recordRunSessionCompletion(run, -1);
            run.lifecycle = 'completed';
            if (this._runsBySession.get(run.runId) === run) {
                this._runsBySession.delete(run.runId);
            }
        }, this._terminalStateRetentionMs);
        run.terminalStateTimer = timer;
        this._terminalStateTimers.add(timer);
    }

    private _completeRun(run: RunSessionState): void {
        run.lifecycle = 'completed';
        this._scheduleTerminalStateCleanup(run);
    }

    private _handleRunSessionNotification(run: RunSessionState, notification: RunSessionNotification): void {
        if (this._disposed || notification.session_id !== run.runId) {
            return;
        }

        const ownedNotification = {
            ...notification,
            dcp_id: run.ownerDcpId,
            session_id: run.runId,
        } as RunSessionNotification;

        if (ownedNotification.notification_type !== 'sessionTerminated') {
            if (run.lifecycle !== 'completed') {
                this._sendNotification(ownedNotification);
            }
            return;
        }

        if (run.adapterCompletionProcessed) {
            return;
        }
        run.adapterCompletionProcessed = true;

        const sessionTerminated = ownedNotification as SessionTerminatedNotification;
        this._recordRunSessionCompletion(run, sessionTerminated.exit_code);
        this._sendTerminalNotification(run, sessionTerminated.exit_code);
        this._completeRun(run);
    }

    private _recordRunSessionCompletion(run: RunSessionState, exitCode: number | undefined): void {
        if (run.telemetryFallbackTimer) {
            clearTimeout(run.telemetryFallbackTimer);
            this._telemetryFallbackTimers.delete(run.telemetryFallbackTimer);
            run.telemetryFallbackTimer = undefined;
        }

        const entry = this._runTelemetryById.get(run.runId);
        if (!entry) {
            return;
        }

        this._runTelemetryById.delete(run.runId);
        const durationMs = Date.now() - entry.startTimeMs;
        const exitBucket = exitCode === undefined
            ? 'unknown'
            : exitCode === 0
                ? 'success'
                : exitCode === -1
                    ? 'canceled'
                    : 'nonzero';
        // Route non-zero exits through the error-event channel so they are surfaced
        // as errors in the telemetry pipeline, consistent with the synchronous
        // launch-failure path above and the dashboard fault path.
        const emitEnd = exitBucket === 'nonzero' ? sendTelemetryErrorEvent : sendTelemetryEvent;
        emitEnd('aspire/vscode/debug/runsession/end', {
            resource_type: entry.resourceType,
            mode: entry.mode,
            exit_code_bucket: exitBucket,
        }, {
            duration_ms: durationMs,
            ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        });

        // Surface a non-zero exit on the parent AppHost debug-session aggregate so
        // the eventual `debug/apphost/end` summary reflects whether any child
        // resource session ended unsuccessfully.
        if (exitBucket === 'nonzero' && exitCode !== undefined) {
            this.recordAppHostProcessExit(entry.debugSessionId, exitCode);
        }
    }

    private _sendTerminalNotification(run: RunSessionState, exitCode?: number): void {
        if (this._disposed || run.terminalNotificationSent) {
            return;
        }
        run.terminalNotificationSent = true;

        const notification: SessionTerminatedNotification = {
            notification_type: 'sessionTerminated',
            session_id: run.runId,
            dcp_id: run.ownerDcpId,
            ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        };
        this._sendNotification(notification);
    }

    private _sendNotification(notification: RunSessionNotification): void {
        if (this._disposed) {
            return;
        }

        // If no WebSocket is available for the session, retain notifications in order
        // until that DCP instance reconnects.
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
                ...(sessionTerminated.exit_code === undefined ? {} : { exit_code: sessionTerminated.exit_code })
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
        if (this._disposed) {
            return;
        }

        // Every run-session start must have one matching end event. Disposal can
        // happen before either an adapter exit or the requested-stop fallback.
        for (const run of this._runsBySession.values()) {
            this._recordRunSessionCompletion(run, -1);
        }

        this._disposed = true;

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

        for (const timer of this._telemetryFallbackTimers) {
            clearTimeout(timer);
        }
        this._telemetryFallbackTimers.clear();
        for (const timer of this._terminalStateTimers) {
            clearTimeout(timer);
        }
        this._terminalStateTimers.clear();
        this._runsBySession.clear();
        this._runTelemetryById.clear();
        this.pendingNotificationQueueByDcpId.clear();
        this.wsBySession.clear();
        this._dashboardTelemetry.dispose();
    }
}

// Cryptographically-secure identifier generators. The DCP instance id is
// used as the keying material for routing notifications back to a specific
// debug session (`wsBySession.set(dcpId, ws)`) — a predictable id combined
// with the WebSocket upgrade endpoint would let a colocated process hijack
// the notification stream. `Math.random()` is NOT cryptographically secure
// (V8's xorshift128+ is predictable from a small number of outputs), so use
// `randomBytes` instead. 16 hex chars = 64 bits of true entropy.
//
// Returns only `[0-9a-f]` so the `getDcpIdPrefix` regex below
// (`aspire-extension-run-[a-z0-9]+`) keeps matching without changes.
export function generateRunId(): string {
    return `run-${randomBytes(8).toString('hex')}`;
}

export function generateDcpIdPrefix(): string {
    return `aspire-extension-run-${randomBytes(8).toString('hex')}`;
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

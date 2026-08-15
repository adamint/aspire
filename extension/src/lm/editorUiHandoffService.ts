import * as vscode from 'vscode';

import {
    isWebDashboardUrl,
    openDashboardInBrowser,
    resolveExplicitDashboardLaunchBehavior,
    showDashboardLaunchNotification,
    type DashboardBrowserType,
} from '../debugger/session/dashboardLauncher';
import { extensionLogOutputChannel } from '../utils/logging';
import { isCommandCancellation } from '../utils/telemetry';
import {
    type EditorUiHandoffDashboardResult,
    type EditorUiHandoffOperations,
    type EditorUiHandoffServiceDependencies,
} from './editorAssistanceToolContracts';
import { type ResolvedAppHostTarget } from './safeAppHostTargetResolver';

/**
 * Performs the editor-only side effects behind the handoff tools.
 *
 * Dashboard URLs remain confined to this service and the shared browser helpers. The
 * model-facing service receives only a finite presentation result, so login tokens can
 * never enter tool output, telemetry, or error text.
 */
export class EditorUiHandoffService implements EditorUiHandoffOperations {
    constructor(private readonly _dependencies: EditorUiHandoffServiceDependencies) {
    }

    async openDashboard(
        target: ResolvedAppHostTarget,
        token: vscode.CancellationToken): Promise<EditorUiHandoffDashboardResult> {
        try {
            throwIfCanceled(token);
            const appHosts = await this._dependencies.appHostRepository.fetchRunningAppHostsOnce(token);
            throwIfCanceled(token);

            const matches = appHosts.filter(appHost =>
                this._dependencies.targetResolver.getIdentityForAppHostPath(appHost.appHostPath) === target.identity);
            const runningMatches = matches.filter(appHost => appHost.status?.toLowerCase() !== 'stopped');
            if (runningMatches.length === 0) {
                return { outcome: 'appHostNotRunning' };
            }
            if (runningMatches.length > 1) {
                return { outcome: 'ambiguousAppHost' };
            }

            const dashboardUrl = runningMatches[0].dashboardUrl;
            if (!dashboardUrl || !isWebDashboardUrl(dashboardUrl)) {
                return { outcome: 'dashboardUnavailable' };
            }

            const sessions = this._dependencies.getAspireDebugSessions(target.identity);
            const editorSession = sessions.length === 1 ? sessions[0] : undefined;
            const resolvedBehavior = resolveExplicitDashboardLaunchBehavior(
                vscode.workspace.getConfiguration('aspire'),
                editorSession?.configuration.dashboardBrowser);
            throwIfCanceled(token);

            if (resolvedBehavior.behavior === 'notification') {
                await showDashboardLaunchNotification({
                    baseUrl: dashboardUrl,
                    source: resolvedBehavior.source,
                });
                return { outcome: 'opened', presentation: 'notification' };
            }

            const browserType: DashboardBrowserType = resolvedBehavior.behavior;
            const presentation = editorSession
                ? await editorSession.openDashboard(dashboardUrl, browserType)
                : await openDashboardInBrowser(dashboardUrl, browserType);
            return presentation
                ? { outcome: 'opened', presentation }
                : { outcome: 'error' };
        }
        catch (error) {
            if (isCommandCancellation(error) || token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            // Browser errors can quote the full login-token URL. Keep this diagnostic
            // intentionally generic so this explicit path never writes the URL to logs.
            extensionLogOutputChannel.error('Aspire open Dashboard language model tool failed.');
            return { outcome: 'error' };
        }
    }

    async openOutput(token: vscode.CancellationToken): Promise<'opened' | 'error'> {
        try {
            throwIfCanceled(token);
            this._dependencies.output.show(true);
            return 'opened';
        }
        catch (error) {
            if (isCommandCancellation(error) || token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            extensionLogOutputChannel.error('Aspire open Output language model tool failed.');
            return 'error';
        }
    }
}

function throwIfCanceled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

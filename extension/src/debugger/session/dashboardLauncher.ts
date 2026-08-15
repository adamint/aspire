import * as vscode from "vscode";
import os from "os";
import { extensionLogOutputChannel } from "../../utils/logging";
import {
  aspireDashboard,
  codespacesLink,
  debugSessionStartTimedOut,
  directLink,
  openAspireDashboard,
  settingsLabel,
} from "../../loc/strings";
import { describeStopFailure, startStop, stopSessionInBackground } from "./stopHelpers";
import { normalizeLaunchFailure, type LaunchFailureMode, type SanitizedLaunchFailure } from "../../services/launchFailureJournal";

export type DashboardLaunchBehavior = 'none' | 'notification' | DashboardBrowserType;
export type DashboardBrowserType = 'openExternalBrowser' | 'integratedBrowser' | 'debugChrome' | 'debugEdge' | 'debugFirefox';
export type DashboardPresentation = 'integratedBrowser' | 'externalBrowser' | 'debugBrowser' | 'notification';
export type DashboardLaunchBehaviorSource = 'debugConfiguration' | 'globalConfiguration' | 'legacyConfiguration' | 'default';
export type ResolvedDashboardLaunchBehavior = {
  readonly behavior: DashboardLaunchBehavior;
  readonly source: DashboardLaunchBehaviorSource;
};

const preOptInDefaultDashboardBrowser: DashboardLaunchBehavior = 'integratedBrowser';

export function normalizeDashboardLaunchBehavior(value: unknown): DashboardLaunchBehavior | undefined {
  return value === 'none'
    || value === 'notification'
    || value === 'openExternalBrowser'
    || value === 'integratedBrowser'
    || value === 'debugChrome'
    || value === 'debugEdge'
    || value === 'debugFirefox'
    ? value
    : undefined;
}

export function resolveDashboardLaunchBehavior(
  aspireConfig: vscode.WorkspaceConfiguration,
  debugConfigurationBehaviorValue?: unknown): ResolvedDashboardLaunchBehavior {
  const debugConfigurationBehavior = normalizeDashboardLaunchBehavior(debugConfigurationBehaviorValue);
  if (debugConfigurationBehavior) {
    return { behavior: debugConfigurationBehavior, source: 'debugConfiguration' };
  }

  const configuredGlobalBehavior = getConfiguredDashboardLaunchBehavior(aspireConfig);
  if (configuredGlobalBehavior === 'none' || configuredGlobalBehavior === 'notification') {
    return { behavior: configuredGlobalBehavior, source: 'globalConfiguration' };
  }

  // Migration precedence is intentionally conservative:
  // - per-launch `dashboardBrowser` always wins because it only affects this debug run;
  // - explicit global `none`/`notification` always wins so users can opt out or opt into the toast;
  // - legacy `notification`/`off` keeps the less intrusive historical behavior even if a new
  //   browser preference is also configured;
  // - legacy `launch` falls through to the new browser preference, or to the pinned pre-opt-in
  //   integrated-browser default when no new preference exists.
  const legacyBehavior = getConfiguredLegacyDashboardLaunchBehavior(aspireConfig);

  if (legacyBehavior) {
    if (legacyBehavior === 'notification' || legacyBehavior === 'none') {
      return { behavior: legacyBehavior, source: 'legacyConfiguration' };
    }

    return {
      behavior: configuredGlobalBehavior ?? preOptInDefaultDashboardBrowser,
      source: configuredGlobalBehavior ? 'globalConfiguration' : 'legacyConfiguration'
    };
  }

  if (configuredGlobalBehavior) {
    return { behavior: configuredGlobalBehavior, source: 'globalConfiguration' };
  }

  return {
    behavior: normalizeDashboardLaunchBehavior(aspireConfig.get<unknown>('dashboardBrowser', 'none')) ?? 'none',
    source: 'default'
  };
}

export function resolveExplicitDashboardLaunchBehavior(
  aspireConfig: vscode.WorkspaceConfiguration,
  debugConfigurationBehaviorValue?: unknown): {
    readonly behavior: Exclude<DashboardLaunchBehavior, 'none'>;
    readonly source: DashboardLaunchBehaviorSource;
  } {
  const debugPreference = normalizeDashboardLaunchBehavior(debugConfigurationBehaviorValue);
  if (debugPreference && debugPreference !== 'none') {
    return { behavior: debugPreference, source: 'debugConfiguration' };
  }

  const configuredPreference = getConfiguredDashboardLaunchBehavior(aspireConfig);
  if (configuredPreference && configuredPreference !== 'none') {
    return { behavior: configuredPreference, source: 'globalConfiguration' };
  }

  const legacyBehavior = getConfiguredLegacyDashboardLaunchBehavior(aspireConfig);
  if (legacyBehavior === 'notification') {
    return { behavior: 'notification', source: 'legacyConfiguration' };
  }

  // `none` suppresses automatic launch; it is not a browser presentation. Explicit
  // handoff still honors any separately configured browser or notification preference,
  // then falls back to the integrated browser.
  return {
    behavior: 'integratedBrowser',
    source: debugPreference === 'none'
      ? 'debugConfiguration'
      : configuredPreference === 'none'
        ? 'globalConfiguration'
        : legacyBehavior
          ? 'legacyConfiguration'
          : 'default',
  };
}

export function isWebDashboardUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }
  catch {
    return false;
  }
}

export interface DashboardLaunchNotificationOptions {
  readonly baseUrl: string;
  readonly codespacesUrl?: string;
  readonly source: DashboardLaunchBehaviorSource;
  readonly delayMs?: number;
}

export async function showDashboardLaunchNotification(options: DashboardLaunchNotificationOptions): Promise<void> {
  if (options.delayMs && options.delayMs > 0) {
    await new Promise<void>(resolve => {
      setTimeout(() => {
        void showDashboardLaunchNotification({ ...options, delayMs: 0 }).finally(resolve);
      }, options.delayMs);
    });
    return;
  }

  const actions: vscode.MessageItem[] = [{ title: directLink }];
  if (options.codespacesUrl) {
    actions.push({ title: codespacesLink });
  }
  actions.push({ title: settingsLabel });

  const selected = await vscode.window.showInformationMessage(openAspireDashboard, ...actions);
  if (!selected) {
    return;
  }

  extensionLogOutputChannel.info(`Selected action: ${selected.title}`);
  if (selected.title === directLink) {
    await openDashboardNotificationLink(options.baseUrl);
  }
  else if (selected.title === codespacesLink && options.codespacesUrl) {
    await openDashboardNotificationLink(options.codespacesUrl);
  }
  else if (selected.title === settingsLabel) {
    openDashboardLaunchBehaviorSettings(options.source);
  }
}

async function openDashboardNotificationLink(url: string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
  catch {
    // The notification has already been presented successfully. Keep the launch result tied to that
    // presentation and avoid logging the URL or the raw error, either of which may contain credentials.
    extensionLogOutputChannel.error('Failed to open the selected Aspire Dashboard link.');
  }
}

export function openDashboardLaunchBehaviorSettings(source: DashboardLaunchBehaviorSource): void {
  if (source === 'debugConfiguration') {
    void vscode.commands.executeCommand('workbench.action.debug.configure');
    return;
  }

  void vscode.commands.executeCommand(
    'workbench.action.openSettings',
    source === 'legacyConfiguration'
      ? 'aspire.enableAspireDashboardAutoLaunch'
      : 'aspire.dashboardBrowser');
}

type DashboardDebugType = 'pwa-chrome' | 'pwa-msedge' | 'firefox';

interface DashboardBrowserOperations {
  readonly openIntegrated: () => Promise<boolean>;
  readonly openExternal: () => Promise<boolean>;
  readonly openDebug: (debugType: DashboardDebugType) => Promise<DashboardPresentation | undefined>;
}

async function openDashboardWithOperations(
  browserType: DashboardBrowserType,
  operations: DashboardBrowserOperations): Promise<DashboardPresentation | undefined> {
  switch (browserType) {
    case 'debugChrome':
      return operations.openDebug('pwa-chrome');
    case 'debugEdge':
      return operations.openDebug('pwa-msedge');
    case 'debugFirefox':
      return operations.openDebug('firefox');
    case 'integratedBrowser':
      return await operations.openIntegrated() ? 'integratedBrowser' : undefined;
    case 'openExternalBrowser':
    default:
      return await operations.openExternal() ? 'externalBrowser' : undefined;
  }
}

export async function openDashboardInBrowser(
  url: string,
  browserType: DashboardBrowserType): Promise<DashboardPresentation | undefined> {
  return openDashboardWithOperations(browserType, {
    openIntegrated: () => runDashboardOpenOperation(
      () => vscode.commands.executeCommand('simpleBrowser.show', url)),
    openExternal: () => runDashboardOpenOperation(
      () => vscode.env.openExternal(vscode.Uri.parse(url))),
    openDebug: async debugType => {
      const didStart = await vscode.debug.startDebugging(
        undefined,
        createDashboardDebugConfiguration(url, debugType));
      if (didStart) {
        return 'debugBrowser';
      }

      extensionLogOutputChannel.warn(`Failed to start debug browser (${debugType}), falling back to default browser`);
      return await runDashboardOpenOperation(
        () => vscode.env.openExternal(vscode.Uri.parse(url)))
        ? 'externalBrowser'
        : undefined;
    },
  });
}

function createDashboardDebugConfiguration(
  url: string,
  debugType: DashboardDebugType): vscode.DebugConfiguration {
  const debugConfig: vscode.DebugConfiguration = {
    type: debugType,
    name: aspireDashboard,
    request: 'launch',
    url,
  };

  if (debugType === 'pwa-chrome' || debugType === 'pwa-msedge') {
    debugConfig.pauseForSourceMap = false;
  }
  else {
    // Firefox requires a webRoot even though the Dashboard sources are not local.
    debugConfig.webRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
    debugConfig.pathMappings = [];
  }

  return debugConfig;
}

async function runDashboardOpenOperation(operation: () => Thenable<unknown>): Promise<boolean> {
  return await operation() !== false;
}

function getConfiguredLegacyDashboardLaunchBehavior(
  aspireConfig: vscode.WorkspaceConfiguration): 'launch' | 'notification' | 'none' | undefined {
  const inspection = aspireConfig.inspect<unknown>('enableAspireDashboardAutoLaunch');
  const configuredValue = inspection?.workspaceFolderValue
    ?? inspection?.workspaceValue
    ?? inspection?.globalValue;

  if (configuredValue === undefined) {
    return undefined;
  }
  if (configuredValue === true || configuredValue === 'launch') {
    return 'launch';
  }
  if (configuredValue === false || configuredValue === 'notification') {
    return 'notification';
  }
  if (configuredValue === 'off') {
    return 'none';
  }

  return undefined;
}

function getConfiguredDashboardLaunchBehavior(
  aspireConfig: vscode.WorkspaceConfiguration): DashboardLaunchBehavior | undefined {
  const inspection = aspireConfig.inspect<unknown>('dashboardBrowser');
  const configuredValue = inspection?.workspaceFolderValue
    ?? inspection?.workspaceValue
    ?? inspection?.globalValue;

  return normalizeDashboardLaunchBehavior(configuredValue);
}

/**
 * The slice of the owning Aspire debug session the dashboard launcher needs: the parent session it
 * matches and parents browser sessions against, the shutdown flags its guards read, and the shared
 * shutdown-budget primitives, so the launcher never gets a whole AspireDebugSession.
 */
export interface DashboardLauncherHost {
  readonly parentSession: vscode.DebugSession;
  readonly isDisposed: boolean;
  readonly isShuttingDown: boolean;
  readonly isStopAttemptInProgress: boolean;
  readonly isExtensionShutdownRequested: boolean;
  readonly dashboardLaunchFailureMode: LaunchFailureMode;
  notifyStateChanged(): void;
  recordDashboardLaunchFailure(failure: SanitizedLaunchFailure): void;
  stopWithinBudget(operation: () => Thenable<void>, sessionName: string, deadline: number, onTimeout?: () => void): Promise<void>;
  waitWithinBudget(stop: PromiseLike<void>, sessionName: string, deadline: number, onTimeout?: () => void, timeoutMessage?: (sessionName: string, seconds: number) => string): Promise<void>;
}

export class DashboardLauncher implements vscode.Disposable {
  /**
   * Dashboard browsers are optional UI children. Give their launch/stop a smaller share of the
   * shutdown budget so a wedged browser adapter cannot starve AppHost and parent teardown.
   */
  private static readonly _dashboardStopTimeoutMs = 2000;

  private readonly _host: DashboardLauncherHost;

  private _dashboardDebugSession: vscode.DebugSession | null = null;
  private _dashboardStopPromise: Promise<void> | undefined;
  private _dashboardTerminationDisposable: vscode.Disposable | undefined;
  private _dashboardTerminationPromise: Promise<void> | undefined;
  private _resolveDashboardTermination: (() => void) | undefined;
  private readonly _pendingDashboardDebugSessionStarts = new Set<Promise<void>>();
  private _dashboardUrl: string | undefined;

  constructor(host: DashboardLauncherHost) {
    this._host = host;
  }

  get dashboardUrl(): string | undefined {
    return this._dashboardUrl;
  }

  /**
   * Whether the dashboard browser has yet to be asked to stop, including a launch that has not
   * produced its session yet.
   */
  get hasSessionsToStop(): boolean {
    return this._dashboardDebugSession !== null
      || this._pendingDashboardDebugSessionStarts.size > 0;
  }

  /**
   * Opens the dashboard URL in the specified browser.
   * For debugChrome/debugEdge/debugFirefox, launches as a child debug session that is stopped by
   * the ordered shutdown or by the late-start handler when shutdown is already in progress.
   */
  async openDashboard(url: string, browserType: DashboardBrowserType): Promise<DashboardPresentation | undefined> {
    extensionLogOutputChannel.info(`Opening dashboard in browser: ${browserType}.`);

    if (this._host.isDisposed || this._host.isStopAttemptInProgress || this._host.isExtensionShutdownRequested) {
      extensionLogOutputChannel.info('Skipping dashboard browser launch because the Aspire session is shutting down.');
      return undefined;
    }

    this._dashboardUrl = url;
    this._host.notifyStateChanged();

    return openDashboardWithOperations(browserType, {
      openIntegrated: () => this.openDashboardCore(
        () => vscode.commands.executeCommand('simpleBrowser.show', url)),
      openExternal: () => this.openDashboardCore(
        () => vscode.env.openExternal(vscode.Uri.parse(url))),
      openDebug: debugType => this.launchDebugBrowser(url, debugType),
    });
  }

  /**
   * Launches a browser as a child debug session.
   * VS Code does not stop this child session when the parent Aspire session terminates, so the
   * started session is tracked here and stopped explicitly during Aspire session shutdown.
   */
  private async launchDebugBrowser(
    url: string,
    debugType: DashboardDebugType): Promise<DashboardPresentation | undefined> {
    const debugConfig = createDashboardDebugConfiguration(url, debugType);

    // Register listener before starting so we don't miss the event.
    // The started session must be matched to *this* Aspire session: concurrent Aspire
    // debug sessions all launch their dashboard with the same configuration name and
    // browser type, so name and type alone would let one session adopt (and later close)
    // another session's browser.
    const disposable = vscode.debug.onDidStartDebugSession((session) => {
      if (session.parentSession?.id === this._host.parentSession.id && session.configuration.name === aspireDashboard && session.type === debugType) {
        this._dashboardDebugSession = session;
        disposable.dispose();
        this.trackDashboardTermination(session);
        if (this._host.isShuttingDown) {
          this.closeDashboardInBackground();
        }
      }
    });

    let didStart: boolean;
    let start: Promise<boolean>;
    try {
      start = Promise.resolve(vscode.debug.startDebugging(
        undefined,
        debugConfig,
        this._host.parentSession));
    }
    catch (error) {
      disposable.dispose();
      this.recordDashboardLaunchFailure(error);
      throw error;
    }
    const completion = start.then(() => undefined, () => undefined);
    this._pendingDashboardDebugSessionStarts.add(completion);
    try {
      // Start as a child debug session so it is stopped alongside this session in `dispose`.
      didStart = await start;
    }
    catch (error) {
      disposable.dispose();
      this.recordDashboardLaunchFailure(error);
      throw error;
    }
    finally {
      this._pendingDashboardDebugSessionStarts.delete(completion);
    }

    if (!didStart) {
      disposable.dispose();
      extensionLogOutputChannel.warn(`Failed to start debug browser (${debugType}), falling back to default browser`);

      // Falling back after disposal would pop an untracked browser window open during
      // teardown, long after the user stopped the session.
      if (this._host.isShuttingDown) {
        return undefined;
      }

      return await this.openDashboardCore(() => vscode.env.openExternal(vscode.Uri.parse(url)))
        ? 'externalBrowser'
        : undefined;
    }

    return 'debugBrowser';
  }

  private async openDashboardCore(operation: () => Thenable<unknown>): Promise<boolean> {
    try {
      const result = await operation();
      if (result === false) {
        this.recordDashboardLaunchFailure();
        return false;
      }

      return true;
    }
    catch (error) {
      this.recordDashboardLaunchFailure(error);
      throw error;
    }
  }

  private recordDashboardLaunchFailure(error?: unknown): void {
    if (this._host.isShuttingDown) {
      return;
    }

    this._host.recordDashboardLaunchFailure(normalizeLaunchFailure({
      stage: 'dashboard',
      category: error === undefined ? 'unknown' : undefined,
      controller: 'editor',
      mode: this._host.dashboardLaunchFailureMode,
      providerKind: 'browser',
      error,
    }));
  }

  /**
   * Closes the dashboard browser if closeDashboardOnDebugEnd is enabled.
   * Handles closing debug browser sessions.
   */
  private closeDashboard(): Promise<void> {
    const aspireConfig = vscode.workspace.getConfiguration('aspire');
    const shouldClose = aspireConfig.get<boolean>('closeDashboardOnDebugEnd', true);

    if (!shouldClose) {
      if (this._dashboardDebugSession) {
        this.clearDashboardDebugSession(this._dashboardDebugSession);
      }
      return Promise.resolve();
    }

    const dashboardDebugSession = this._dashboardDebugSession;
    if (!dashboardDebugSession) {
      return Promise.resolve();
    }

    if (this._dashboardStopPromise) {
      return this._dashboardStopPromise;
    }

    extensionLogOutputChannel.info('Closing dashboard browser...');
    const stopRequest = startStop(() => vscode.debug.stopDebugging(dashboardDebugSession));
    const stop = this._dashboardTerminationPromise
      ? Promise.race([stopRequest, this._dashboardTerminationPromise])
      : stopRequest;
    const attempt = stop.then(
      () => {
        this.clearDashboardDebugSession(dashboardDebugSession);
        if (this._dashboardStopPromise === attempt) {
          this._dashboardStopPromise = undefined;
        }
        extensionLogOutputChannel.info('Dashboard debug session stopped.');
      },
      err => {
        // A natural termination can race the stop request and remove the session before VS Code
        // settles the request. The termination event is authoritative: there is nothing left to
        // retry even if the stale stop request rejects.
        if (this._dashboardDebugSession !== dashboardDebugSession) {
          return;
        }
        if (this._dashboardStopPromise === attempt) {
          this._dashboardStopPromise = undefined;
        }
        throw err;
      });
    this._dashboardStopPromise = attempt;

    return attempt;
  }

  async stopDashboardWithinBudget(shutdownDeadline: number): Promise<void> {
    const deadline = Math.min(shutdownDeadline, Date.now() + DashboardLauncher._dashboardStopTimeoutMs);

    while (this._pendingDashboardDebugSessionStarts.size > 0) {
      const pendingStarts = [...this._pendingDashboardDebugSessionStarts];
      const results = await Promise.allSettled(pendingStarts.map(
        start => this._host.waitWithinBudget(
          start,
          aspireDashboard,
          deadline,
          undefined,
          debugSessionStartTimedOut)));
      for (let index = 0; index < results.length; index++) {
        if (results[index].status === 'rejected') {
          // A browser launch is optional UI work. Do not let a wedged launch block AppHost and
          // parent teardown; the start-event handler will close the browser if it appears later.
          this._pendingDashboardDebugSessionStarts.delete(pendingStarts[index]);
          extensionLogOutputChannel.warn(`Dashboard debug session launch did not settle before shutdown: ${describeStopFailure((results[index] as PromiseRejectedResult).reason)}`);
        }
      }
    }

    await this._host.stopWithinBudget(
      () => this.closeDashboard(),
      this._dashboardDebugSession?.name ?? aspireDashboard,
      deadline,
      () => { this._dashboardStopPromise = undefined; });
  }

  private trackDashboardTermination(session: vscode.DebugSession): void {
    this._dashboardTerminationDisposable?.dispose();
    this._dashboardTerminationPromise = new Promise<void>(resolve => {
      this._resolveDashboardTermination = resolve;
    });
    const disposable = vscode.debug.onDidTerminateDebugSession(terminatedSession => {
      if (terminatedSession.id === session.id) {
        this.clearDashboardDebugSession(session);
      }
    });
    this._dashboardTerminationDisposable = disposable;
  }

  private clearDashboardDebugSession(session: vscode.DebugSession): void {
    if (this._dashboardDebugSession !== session) {
      return;
    }

    this._resolveDashboardTermination?.();
    this._dashboardDebugSession = null;
    this._dashboardStopPromise = undefined;
    this._dashboardTerminationDisposable?.dispose();
    this._dashboardTerminationDisposable = undefined;
    this._dashboardTerminationPromise = undefined;
    this._resolveDashboardTermination = undefined;
  }

  private closeDashboardInBackground(): void {
    startStop(() => this.closeDashboard()).catch(err => {
      extensionLogOutputChannel.warn(`Failed to stop dashboard debug session: ${describeStopFailure(err)}`);

      // Once disposal has released this session from the extension context, no later caller can
      // retry a browser that arrived after the ordered shutdown's launch budget. Give that narrow
      // finalization race one fresh VS Code stop request before giving up.
      if (this._host.isDisposed && this._dashboardDebugSession) {
        stopSessionInBackground(() => this.closeDashboard(), 'dashboard debug session after finalization');
      }
    });
  }

  dispose(): void {
    // Normal teardown awaits this stop as part of stopAllSessions. Keep an idempotent background
    // fallback for direct finalization during extension shutdown.
    this.closeDashboardInBackground();
    this._dashboardTerminationDisposable?.dispose();
    this._dashboardTerminationDisposable = undefined;
  }
}

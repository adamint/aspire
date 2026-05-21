import * as vscode from "vscode";
import { aspireDashboard } from "../loc/strings";
import { extensionLogOutputChannel } from "../utils/logging";

export type DashboardBrowserType = 'openExternalBrowser' | 'integratedBrowser' | 'debugChrome' | 'debugEdge' | 'debugFirefox';

type DebugBrowserType = 'pwa-chrome' | 'pwa-msedge' | 'firefox';

type OpenDashboardBrowserOptions = {
  parentSession?: vscode.DebugSession;
  onDidStartDebugBrowser?: (session: vscode.DebugSession) => void;
};

export async function openDashboardInBrowser(url: string, browserType: DashboardBrowserType, options: OpenDashboardBrowserOptions = {}): Promise<void> {
  extensionLogOutputChannel.info(`Opening dashboard in browser: ${browserType}, URL: ${url}`);

  switch (browserType) {
    case 'debugChrome':
      await launchDebugBrowser(url, 'pwa-chrome', options);
      break;

    case 'debugEdge':
      await launchDebugBrowser(url, 'pwa-msedge', options);
      break;

    case 'debugFirefox':
      await launchDebugBrowser(url, 'firefox', options);
      break;

    case 'integratedBrowser':
      await vscode.commands.executeCommand('simpleBrowser.show', await getClientAccessibleUrl(url));
      break;

    case 'openExternalBrowser':
    default:
      // VS Code automatically resolves http(s) URIs passed to openExternal for remote
      // extension hosts, including setting up SSH port forwarding when necessary.
      // See vscode.env.asExternalUri in @types/vscode for the documented behavior.
      await vscode.env.openExternal(vscode.Uri.parse(url));
      break;
  }
}

async function launchDebugBrowser(url: string, debugType: DebugBrowserType, options: OpenDashboardBrowserOptions): Promise<void> {
  const debugConfig: vscode.DebugConfiguration = {
    type: debugType,
    name: aspireDashboard,
    request: 'launch',
    url: await getClientAccessibleUrl(url),
  };

  if (debugType === 'pwa-chrome' || debugType === 'pwa-msedge') {
    debugConfig.pauseForSourceMap = false;
  }
  else if (debugType === 'firefox') {
    debugConfig.webRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    debugConfig.pathMappings = [];
  }

  const disposable = vscode.debug.onDidStartDebugSession((session) => {
    if (session.configuration.name === aspireDashboard && session.type === debugType) {
      options.onDidStartDebugBrowser?.(session);
      disposable.dispose();
    }
  });

  const didStart = await vscode.debug.startDebugging(
    undefined,
    debugConfig,
    options.parentSession
  );

  if (!didStart) {
    disposable.dispose();
    extensionLogOutputChannel.warn(`Failed to start debug browser (${debugType}), falling back to default browser`);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function getClientAccessibleUrl(url: string): Promise<string> {
  const uri = vscode.Uri.parse(url);
  if (uri.scheme !== 'http' && uri.scheme !== 'https') {
    return url;
  }

  try {
    return (await vscode.env.asExternalUri(uri)).toString(true);
  }
  catch (err) {
    extensionLogOutputChannel.warn(`Failed to resolve dashboard URL for external access: ${err}`);
    return url;
  }
}

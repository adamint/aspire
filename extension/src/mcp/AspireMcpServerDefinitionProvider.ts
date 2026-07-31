import * as vscode from 'vscode';
import { resolveCliPath } from '../utils/cliPath';
import { extensionLogOutputChannel } from '../utils/logging';
import { getCmdShimSpawnCommandWithoutVerbatimArguments, shouldWrapWithCmd } from '../utils/cmdShim';
import { getRegisterMcpServerInWorkspace, registerMcpServerInWorkspaceSetting } from '../utils/settings';

const mcpServerLabel = 'Aspire';
const mcpServerArgs = ['agent', 'mcp'];
const aspireCliExecutablePathSetting = 'aspire.aspireCliExecutablePath';

/**
 * Builds the stdio definition VS Code uses to launch `aspire agent mcp`.
 *
 * A .NET global-tool install exposes `aspire.cmd`, and VS Code spawns stdio MCP
 * servers with `shell: false`, so handing the shim over directly fails with
 * `spawn EINVAL` on Windows (https://github.com/nodejs/node/issues/52681).
 * Command shims are therefore routed through cmd.exe. `McpStdioServerDefinition`
 * cannot request `windowsVerbatimArguments`, so this uses the argv-shaped wrapper
 * rather than the single-command-string form used for extension-owned spawns.
 */
export function createAspireMcpServerDefinition(cliPath: string): vscode.McpStdioServerDefinition {
    if (!shouldWrapWithCmd(cliPath)) {
        return new vscode.McpStdioServerDefinition(mcpServerLabel, cliPath, [...mcpServerArgs]);
    }

    const { command, args } = getCmdShimSpawnCommandWithoutVerbatimArguments(cliPath, mcpServerArgs);
    return new vscode.McpStdioServerDefinition(mcpServerLabel, command, args);
}

/**
 * Provides the Aspire MCP server definition to VS Code so it appears
 * automatically in the MCP tools list when the Aspire CLI is available
 * and the workspace contains an Aspire project.
 */
export class AspireMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

    private _cliPath: string | undefined;
    private _cliAvailable: boolean = false;
    private _shouldProvide: boolean = false;
    private _configChangeDisposable: vscode.Disposable | undefined;
    private _workspaceFolderChangeDisposable: vscode.Disposable | undefined;

    constructor() {
        // Re-evaluate when the setting changes
        this._configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(registerMcpServerInWorkspaceSetting)
                || e.affectsConfiguration(aspireCliExecutablePathSetting)) {
                this.refresh();
            }
        });

        // Re-evaluate when workspace folders change
        this._workspaceFolderChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.refresh();
        });
    }

    async refresh(): Promise<void> {
        const [cliResult, shouldProvide] = await Promise.all([
            resolveCliPath(),
            checkShouldProvideMcpServer(),
        ]);

        const changed =
            this._cliAvailable !== cliResult.available ||
            this._cliPath !== cliResult.cliPath ||
            this._shouldProvide !== shouldProvide;

        this._cliAvailable = cliResult.available;
        this._cliPath = cliResult.cliPath;
        this._shouldProvide = shouldProvide;

        if (changed) {
            extensionLogOutputChannel.info(`Aspire MCP server definition changed: cliAvailable=${cliResult.available}, shouldProvide=${shouldProvide}`);
            this._onDidChange.fire();
        }
    }

    provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.ProviderResult<vscode.McpStdioServerDefinition[]> {
        if (!this._cliAvailable || !this._shouldProvide || !this._cliPath) {
            return [];
        }

        try {
            return [createAspireMcpServerDefinition(this._cliPath)];
        }
        catch (error) {
            // The wrapper rejects paths carrying terminal control characters. Surfacing no
            // server is better than throwing out of the provider and breaking MCP discovery.
            extensionLogOutputChannel.error(`Unable to build the Aspire MCP server definition: ${error}`);
            return [];
        }
    }

    dispose(): void {
        this._configChangeDisposable?.dispose();
        this._workspaceFolderChangeDisposable?.dispose();
        this._onDidChange.dispose();
    }
}

/**
 * Determines whether the Aspire MCP server should be provided.
 *
 * The server is provided only when workspace folders are open and the
 * "aspire.registerMcpServerInWorkspace" setting is enabled.
 */
async function checkShouldProvideMcpServer(): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return false;
    }

    return getRegisterMcpServerInWorkspace();
}

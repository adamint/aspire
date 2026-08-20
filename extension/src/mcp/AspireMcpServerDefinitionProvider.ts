import * as path from 'path';
import * as vscode from 'vscode';
import { CliPathResolver, cliPathResolver } from '../utils/cliPath';
import { workspaceFolderCliPathTarget } from '../utils/cliPathVariables';
import { extensionLogOutputChannel } from '../utils/logging';
import { canVsCodeQuoteCommandShimLaunch, getCmdShimSpawnCommandWithoutVerbatimArguments, shouldWrapWithCmd } from '../utils/cmdShim';
import { getRegisterMcpServerInWorkspaceOverride, registerMcpServerInWorkspaceSetting } from '../utils/settings';
import { ASPIRE_CLI_PATH_ENV_VAR, getForwardableResolvedAspireCliPath, ResolvedCliPathDependencies } from '../utils/cliPathEnvironment';
import { agentMcpCapability } from '../types/configInfo';
import type { CapabilityStatus } from '../types/configInfo';
import type { ConfigInfoOptions } from '../utils/configInfoProvider';
import type { CandidateAppHostDisplayInfo } from '../utils/appHostCandidateTypes';
import { getLexicalAppHostPathKey } from '../utils/paths/comparison';
import { isBuildableAppHostCandidate } from '../utils/appHostCandidateSelection';

const mcpServerLabel = 'Aspire';
const mcpServerArgs = ['agent', 'mcp'];
const appHostOption = '--apphost';
const aspireCliExecutablePathSetting = 'aspire.aspireCliExecutablePath';

export interface AspireMcpServerDefinitionOptions {
    label?: string;
    cwd?: vscode.Uri;
    deps?: ResolvedCliPathDependencies;
}

/**
 * Builds the stdio definition VS Code uses to launch `aspire agent mcp` pinned to one AppHost.
 *
 * The AppHost path is baked into the arguments when the definition is created so a running MCP
 * server keeps serving the AppHost it was registered for, even if discovery later reports a
 * different candidate set.
 *
 * Supported VS Code versions resolve the executable, quote a token only when it contains
 * whitespace, and hand the joined string to `cmd.exe` with verbatim arguments. See:
 * https://github.com/microsoft/vscode/blob/1.102.3/src/vs/workbench/api/node/extHostMcpNode.ts#L141-L167
 *
 * That handles a spaced AppHost path correctly, so a command shim is launched directly whenever
 * every token survives that quoting. Only the remaining case - a metacharacter in a token with no
 * whitespace, which VS Code leaves unquoted - is routed through cmd.exe so the metacharacter stays
 * literal. Routing everything through the wrapper is not an option: cmd.exe strips carets before a
 * batch shim splits `%1`, so the wrapper cannot carry a spaced argument.
 *
 * @throws When the pinned launch has no safe Windows representation. Callers registering many
 * AppHosts must contain this per pin so one unrepresentable path cannot block the others.
 */
export function createAspireMcpServerDefinition(
    cliPath: string,
    appHostPath: string,
    options: AspireMcpServerDefinitionOptions = {},
): vscode.McpStdioServerDefinition {
    const label = options.label ?? mcpServerLabel;
    // `aspire agent mcp` can build an AppHost, and that build inherits this environment. An
    // unbundled framework-dependent CLI path makes MSBuild's ResolveAspireCliBundle bind bundle
    // assets to a CLI that has no bundle layout (ASPIRE009), so it must not be forwarded. Every
    // other AspireCliPath producer applies the same guard; omitting the variable lets the build
    // fall back to PATH probing, exactly as those sites do.
    const forwardableCliPath = options.deps === undefined
        ? getForwardableResolvedAspireCliPath(cliPath)
        : getForwardableResolvedAspireCliPath(cliPath, options.deps);
    const env = forwardableCliPath === undefined ? undefined : { [ASPIRE_CLI_PATH_ENV_VAR]: forwardableCliPath };
    const args = [...mcpServerArgs, appHostOption, appHostPath];
    let definition: vscode.McpStdioServerDefinition;
    if (!shouldWrapWithCmd(cliPath) || canVsCodeQuoteCommandShimLaunch(cliPath, args)) {
        definition = new vscode.McpStdioServerDefinition(label, cliPath, args, env);
    }
    else {
        const { command, args: shimArgs } = getCmdShimSpawnCommandWithoutVerbatimArguments(cliPath, args);
        definition = new vscode.McpStdioServerDefinition(label, command, shimArgs, env);
    }
    definition.cwd = options.cwd;
    return definition;
}

/**
 * The AppHost discovery surface the MCP provider depends on. {@link AppHostDiscoveryService}
 * satisfies it; declaring only what is used keeps the provider testable without a CLI.
 */
export interface McpAppHostDiscoverySource {
    discover(workspaceFolder: vscode.WorkspaceFolder): Promise<CandidateAppHostDisplayInfo[]>;
    readonly onDidChangeCandidates: vscode.Event<vscode.WorkspaceFolder>;
}

/**
 * The CLI capability surface the MCP provider depends on. {@link ConfigInfoProvider} satisfies it.
 */
export interface McpCapabilityProbe {
    getCapabilityStatus(capability: string, options?: ConfigInfoOptions): Promise<CapabilityStatus>;
}

export interface AspireMcpServerDefinitionProviderDependencies {
    appHostDiscovery: McpAppHostDiscoverySource;
    capabilityProbe: McpCapabilityProbe;
}

interface PinnedAppHost {
    cliPath: string;
    appHostPath: string;
}

/**
 * A pinned AppHost after cross-workspace deduplication, carrying the folder that owns it. The
 * owner supplies both the working directory and the display label, so it is part of the pin from
 * this point on rather than being re-derived per definition.
 */
interface OwnedPinnedAppHost extends PinnedAppHost {
    owner: vscode.WorkspaceFolder;
    comparisonKey: string;
}

interface RegisteredDefinition {
    definition: vscode.McpStdioServerDefinition;
    cliPath: string;
}

/**
 * Provides one pinned Aspire MCP server definition per discovered AppHost so the servers appear
 * automatically in VS Code's MCP tools list.
 *
 * A definition is registered for a workspace folder only when the workspace is trusted, the user
 * has not opted out, the CLI resolved for that folder advertises {@link agentMcpCapability}, and
 * discovery reports at least one buildable AppHost. Every other case fails closed: a CLI that
 * predates the capability, a probe that cannot complete, or a gate that fails outright registers
 * nothing rather than launching a command the CLI may not understand or leaving a stale server
 * published against state that can no longer be verified.
 *
 * The published set is keyed by AppHost, not by folder, so nested multi-root folders that each
 * discover the same AppHost still yield a single server.
 */
export class AspireMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

    private readonly _appHostDiscovery: McpAppHostDiscoverySource;
    private readonly _capabilityProbe: McpCapabilityProbe;
    private _definitions: vscode.McpStdioServerDefinition[] = [];
    private _definitionsByPin = new Map<string, RegisteredDefinition>();
    private _refreshGeneration = 0;
    private _disposed = false;
    private _configChangeDisposable: vscode.Disposable | undefined;
    private _workspaceFolderChangeDisposable: vscode.Disposable | undefined;
    private _workspaceTrustGrantDisposable: vscode.Disposable | undefined;
    private _cliPathForwardingChangeDisposable: vscode.Disposable | undefined;
    private _candidateChangeDisposable: vscode.Disposable | undefined;

    constructor(
        dependencies: AspireMcpServerDefinitionProviderDependencies,
        private readonly _resolver: CliPathResolver = cliPathResolver,
    ) {
        this._appHostDiscovery = dependencies.appHostDiscovery;
        this._capabilityProbe = dependencies.capabilityProbe;

        // Re-evaluate when the explicit opt-in/opt-out or the CLI selection changes. A different
        // CLI can advertise a different capability set, so the capability probe reruns with it.
        this._configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(registerMcpServerInWorkspaceSetting)
                || e.affectsConfiguration(aspireCliExecutablePathSetting)) {
                void this.refresh();
            }
        });

        // Re-evaluate when workspace folders change
        this._workspaceFolderChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void this.refresh();
        });

        this._workspaceTrustGrantDisposable = vscode.workspace.onDidGrantWorkspaceTrust(() => {
            void this.refresh();
        });

        // Another CLI consumer can discover that the configured path stopped
        // working or that an unpersisted fallback changed. Re-resolve the MCP
        // command so it cannot keep serving the stale path.
        this._cliPathForwardingChangeDisposable = this._resolver.onDidChangeForwarding(() => void this.refresh());

        // Discovery owns the authoritative AppHost candidate set and already watches the file
        // system for it, so subscribe to its change event instead of polling for new AppHosts.
        this._candidateChangeDisposable = this._appHostDiscovery.onDidChangeCandidates(() => void this.refresh());
    }

    async refresh(): Promise<void> {
        const refreshGeneration = ++this._refreshGeneration;
        if (this._disposed) {
            return;
        }

        try {
            await this._refresh(refreshGeneration);
        }
        catch (error) {
            // Every caller is a VS Code event handler that discards this promise, so an escaping
            // rejection would become an unhandled rejection and silently leave the previously
            // published servers in place. Publishing nothing is the only safe outcome: the gates
            // that decide whether a server may run could not be evaluated, so no server may run.
            if (refreshGeneration !== this._refreshGeneration) {
                return;
            }

            extensionLogOutputChannel.error(`Unregistering Aspire MCP server definitions: refresh failed: ${error instanceof Error ? error.message : String(error)}`);
            this._publish([], new Map());
        }
    }

    private async _refresh(refreshGeneration: number): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        // Restricted Mode must never launch a repository-controlled CLI, so no folder is probed
        // until the whole workspace is trusted.
        const pinsByFolder = vscode.workspace.isTrusted
            ? await Promise.all(workspaceFolders.map(folder => this._resolvePinnedAppHostsSafely(folder)))
            : [];

        if (refreshGeneration !== this._refreshGeneration) {
            return;
        }

        const definitions: vscode.McpStdioServerDefinition[] = [];
        const definitionsByPin = new Map<string, RegisteredDefinition>();
        const registeredLabels = new Set<string>();
        for (const pin of selectWorkspacePinnedAppHosts(workspaceFolders, pinsByFolder)) {
            const label = createPinnedServerLabel(pin);

            // VS Code identifies an MCP server by its label. Two folders that share a name and
            // hold the same relative AppHost path are the one case this label cannot tell apart,
            // and registering both would give VS Code two servers with one identity. Keep the
            // first in the deterministic order and report the one that is skipped.
            if (registeredLabels.has(label)) {
                extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${pin.appHostPath}': label '${label}' is already registered for another AppHost.`);
                continue;
            }

            // The pin key is the AppHost identity, so reusing an existing definition can only ever
            // keep serving the same AppHost. Reuse it when nothing else about the launch changed
            // so an unrelated refresh does not restart a running MCP server.
            const registered = this._definitionsByPin.get(pin.comparisonKey);
            let definition: vscode.McpStdioServerDefinition;
            if (registered !== undefined
                && registered.cliPath === pin.cliPath
                && registered.definition.label === label
                && registered.definition.cwd?.toString() === pin.owner.uri.toString()) {
                definition = registered.definition;
            }
            else {
                try {
                    definition = createAspireMcpServerDefinition(pin.cliPath, pin.appHostPath, { label, cwd: pin.owner.uri });
                }
                catch (error) {
                    // A path with no safe Windows launch is a property of that pin alone.
                    // Skipping only that pin keeps every other AppHost registered instead of
                    // aborting the refresh and freezing the whole published set.
                    extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${pin.appHostPath}': ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
            }

            registeredLabels.add(label);
            definitionsByPin.set(pin.comparisonKey, { definition, cliPath: pin.cliPath });
            definitions.push(definition);
        }

        this._publish(definitions, definitionsByPin);
    }

    private _publish(
        definitions: vscode.McpStdioServerDefinition[],
        definitionsByPin: Map<string, RegisteredDefinition>,
    ): void {
        const changed = !areMcpDefinitionsEqual(this._definitions, definitions);
        this._definitions = definitions;
        this._definitionsByPin = definitionsByPin;

        if (changed) {
            extensionLogOutputChannel.info(`Aspire MCP server definitions changed: count=${definitions.length}`);
            this._onDidChange.fire();
        }
    }

    provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.ProviderResult<vscode.McpStdioServerDefinition[]> {
        return [...this._definitions];
    }

    dispose(): void {
        // Bumping the generation makes any in-flight refresh discard its result, and the flag
        // stops a later event from publishing through an already-disposed change emitter.
        this._disposed = true;
        this._refreshGeneration++;
        this._configChangeDisposable?.dispose();
        this._workspaceFolderChangeDisposable?.dispose();
        this._workspaceTrustGrantDisposable?.dispose();
        this._cliPathForwardingChangeDisposable?.dispose();
        this._candidateChangeDisposable?.dispose();
        this._onDidChange.dispose();
    }

    /**
     * Resolves one folder's AppHosts without ever rejecting. A folder's gates are independent of
     * every other folder's, so a failure there must reduce that folder to zero registrations
     * rather than abort the refresh and freeze the whole published set.
     */
    private async _resolvePinnedAppHostsSafely(workspaceFolder: vscode.WorkspaceFolder): Promise<PinnedAppHost[]> {
        try {
            return await this._resolvePinnedAppHosts(workspaceFolder);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${workspaceFolder.uri.fsPath}': ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Resolves the AppHosts that may be registered for one workspace folder. Every gate is folder
     * scoped: the opt-out, the CLI, its capabilities, and discovery all belong to that folder, so
     * one folder can register servers while another registers none.
     */
    private async _resolvePinnedAppHosts(workspaceFolder: vscode.WorkspaceFolder): Promise<PinnedAppHost[]> {
        if (getRegisterMcpServerInWorkspaceOverride(workspaceFolder.uri) === false) {
            return [];
        }

        const target = workspaceFolderCliPathTarget(workspaceFolder);
        let cliResult: Awaited<ReturnType<CliPathResolver['resolve']>>;
        try {
            cliResult = await this._resolver.resolve(target);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${workspaceFolder.uri.fsPath}': CLI resolution failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }

        if (!cliResult.available) {
            return [];
        }

        // Strict advertisement: a CLI that does not report the capability - including one too old
        // to report capabilities at all - never gets `aspire agent mcp --apphost` spawned at it.
        let capabilityStatus: CapabilityStatus;
        try {
            capabilityStatus = await this._capabilityProbe.getCapabilityStatus(agentMcpCapability, {
                suppressErrors: true,
                cliPath: cliResult.cliPath,
                target,
            });
        }
        catch (error) {
            // `suppressErrors` covers reported CLI failures, not a probe that throws outright, so
            // an unexpected rejection still has to fail closed here.
            extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${workspaceFolder.uri.fsPath}': CLI capability probe failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }

        if (capabilityStatus !== 'supported') {
            extensionLogOutputChannel.info(`Skipping Aspire MCP server registration for '${workspaceFolder.uri.fsPath}': CLI capability '${agentMcpCapability}' is ${capabilityStatus}.`);
            return [];
        }

        let candidates: CandidateAppHostDisplayInfo[];
        try {
            candidates = await this._appHostDiscovery.discover(workspaceFolder);
        }
        catch (error) {
            extensionLogOutputChannel.warn(`Skipping Aspire MCP server registration for '${workspaceFolder.uri.fsPath}': AppHost discovery failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }

        const appHostPathsByKey = new Map<string, string>();
        for (const candidate of candidates) {
            if (!isBuildableAppHostCandidate(candidate)) {
                continue;
            }

            // Pin an absolute path anchored to the owning folder: the MCP server outlives this
            // refresh and must not depend on the working directory VS Code launches it from.
            const appHostPath = path.resolve(workspaceFolder.uri.fsPath, candidate.path);
            const key = getLexicalAppHostPathKey(appHostPath);
            if (!appHostPathsByKey.has(key)) {
                appHostPathsByKey.set(key, appHostPath);
            }
        }

        return [...appHostPathsByKey.entries()]
            .sort(([leftKey], [rightKey]) => compareOrdinal(leftKey, rightKey))
            .map(([, appHostPath]) => ({ cliPath: cliResult.cliPath, appHostPath }));
    }
}

function compareOrdinal(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

/**
 * Reduces the per-folder pins to one pin per AppHost for the whole workspace.
 *
 * Nested multi-root folders can each discover the same AppHost, and registering it once per
 * folder would start two MCP servers competing over one project. The lowest-index folder that
 * discovered an AppHost owns it, so appending or removing an unrelated folder never moves
 * ownership - and therefore never renames or restarts - a definition that already exists.
 */
function selectWorkspacePinnedAppHosts(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    pinsByFolder: readonly PinnedAppHost[][],
): OwnedPinnedAppHost[] {
    const ownedPinsByKey = new Map<string, OwnedPinnedAppHost>();
    pinsByFolder.forEach((pins, index) => {
        const owner = workspaceFolders[index];
        for (const pin of pins) {
            const comparisonKey = getLexicalAppHostPathKey(pin.appHostPath);
            if (!ownedPinsByKey.has(comparisonKey)) {
                ownedPinsByKey.set(comparisonKey, { ...pin, owner, comparisonKey });
            }
        }
    });

    // Order by AppHost identity rather than discovery order so the published set - and the winner
    // of the duplicate-label guard - does not depend on which folder answered first.
    return [...ownedPinsByKey.values()].sort((left, right) => compareOrdinal(left.comparisonKey, right.comparisonKey));
}

/**
 * Builds the display label for a pinned server from the AppHost path and its owning folder's
 * name, both of which are fixed for the lifetime of the pin.
 *
 * The label is always folder-qualified. Formatting it differently for a single-folder workspace
 * would rename - and so restart - an existing server the moment an unrelated folder is added.
 * For the same reason the folder name is used verbatim rather than being disambiguated with an
 * ordinal: an ordinal depends on how many folders share that name, so opening a second `repo`
 * folder would rename the first one's servers. Two folders that share a name therefore produce
 * readable-but-similar labels, and the caller's duplicate-label guard handles the only case that
 * is genuinely ambiguous - the same relative AppHost path under both of them.
 */
function createPinnedServerLabel(pin: OwnedPinnedAppHost): string {
    const relativePath = path.relative(pin.owner.uri.fsPath, pin.appHostPath);
    const appHostLabel = relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
        ? relativePath.split(path.sep).join('/')
        : pin.appHostPath;
    return `${mcpServerLabel} (${pin.owner.name}: ${appHostLabel})`;
}

function areMcpDefinitionsEqual(
    left: readonly vscode.McpStdioServerDefinition[],
    right: readonly vscode.McpStdioServerDefinition[],
): boolean {
    return left.length === right.length && left.every((definition, index) => isSameMcpDefinition(definition, right[index]));
}

function isSameMcpDefinition(definition: vscode.McpStdioServerDefinition, other: vscode.McpStdioServerDefinition): boolean {
    return definition.label === other.label
        && definition.command === other.command
        && definition.cwd?.toString() === other.cwd?.toString()
        && definition.args.length === other.args.length
        && definition.args.every((argument, argumentIndex) => argument === other.args[argumentIndex])
        && JSON.stringify(definition.env) === JSON.stringify(other.env);
}

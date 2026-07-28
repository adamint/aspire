import * as vscode from 'vscode';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isRustLaunchConfiguration, RustLaunchConfiguration } from "../../dcp/types";
import { invalidLaunchConfiguration, rustBuildFailedWithError, rustBuildFailedWithExitCode, rustBuildProducedNoExecutable, rustDisplayName, rustLabel } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";
import { AspireDebugSession } from "../AspireDebugSession";

// cargo's own diagnostic message, emitted once per compiler-message when --message-format=json is used:
//   {"reason":"compiler-message","message":{"rendered":"warning: unused variable...","level":"warning"}}
// The artifact message we actually need looks like:
//   {"reason":"compiler-artifact","target":{"name":"myapp","kind":["bin"]},"executable":"/repo/target/debug/myapp","fresh":false}
// "executable" is only populated for targets that produce a runnable binary (bins, examples, integration
// tests); library-only crates never set it. When multiple binaries are built (e.g. a workspace-wide
// `cargo build`), the last matching artifact wins, which matches the common case of a single bin target
// (any `--bin <name>` filter already narrows the build to one target before this code ever runs).
interface CargoCompilerArtifactMessage {
    reason: 'compiler-artifact';
    target?: { name?: string; kind?: string[] };
    executable?: string | null;
}

interface CargoCompilerMessage {
    reason: 'compiler-message';
    message?: { rendered?: string; level?: string };
}

type CargoBuildMessage = CargoCompilerArtifactMessage | CargoCompilerMessage | { reason: string };

export interface IRustService {
    buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], filter: string | undefined): Promise<string>;
}

export class RustService implements IRustService {
    private readonly _debugSession: AspireDebugSession;

    constructor(debugSession: AspireDebugSession) {
        this._debugSession = debugSession;
    }

    private writeToDebugConsole(message: string, category: 'stdout' | 'stderr'): void {
        this._debugSession.sendMessage(message, false, category);
    }

    async buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], filter: string | undefined): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            // --message-format=json lets us reliably discover the compiled binary's absolute path
            // instead of guessing the target/<profile>/<name> layout (which varies with --release,
            // custom target directories, and cross-compilation).
            const args = [...cargoArgs, '--message-format=json'];
            extensionLogOutputChannel.info(`Building Rust application in ${workingDirectory} using: cargo ${args.join(' ')}`);

            const buildProcess = spawn('cargo', args, { cwd: workingDirectory });

            let executablePath: string | undefined;
            let stderrOutput = '';

            const rl = readline.createInterface({ input: buildProcess.stdout });
            rl.on('line', line => {
                let message: CargoBuildMessage;
                try {
                    message = JSON.parse(line);
                } catch {
                    // Not every line cargo writes to stdout under --message-format=json is guaranteed to be
                    // JSON (some toolchain shims interleave plain text); surface it rather than dropping it.
                    this.writeToDebugConsole(`${line}\n`, 'stdout');
                    return;
                }

                if (message.reason === 'compiler-message') {
                    const rendered = (message as CargoCompilerMessage).message?.rendered;
                    if (rendered) {
                        this.writeToDebugConsole(rendered, (message as CargoCompilerMessage).message?.level === 'error' ? 'stderr' : 'stdout');
                    }
                } else if (message.reason === 'compiler-artifact') {
                    const artifact = message as CargoCompilerArtifactMessage;
                    if (artifact.executable && artifact.target?.kind?.includes('bin') && (!filter || artifact.target?.name === filter)) {
                        executablePath = artifact.executable;
                    }
                }
            });

            buildProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString();
                stderrOutput += output;
                this.writeToDebugConsole(output, 'stderr');
            });

            buildProcess.on('error', err => {
                extensionLogOutputChannel.error(`cargo build process error: ${err}`);
                reject(new Error(rustBuildFailedWithError(workingDirectory, err.message)));
            });

            buildProcess.on('close', code => {
                if (code !== 0) {
                    reject(new Error(rustBuildFailedWithExitCode(workingDirectory, stderrOutput || `${code}`)));
                    return;
                }

                if (!executablePath) {
                    reject(new Error(rustBuildProducedNoExecutable(workingDirectory)));
                    return;
                }

                resolve(executablePath);
            });
        });
    }
}

function asRustConfig(launchConfig: ExecutableLaunchConfiguration): RustLaunchConfiguration {
    if (isRustLaunchConfiguration(launchConfig)) {
        return launchConfig;
    }

    extensionLogOutputChannel.info(`The resource type was not rust for ${JSON.stringify(launchConfig)}`);
    throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
}

function getProjectFile(launchConfig: ExecutableLaunchConfiguration): string {
    const config = asRustConfig(launchConfig);
    return config.working_directory || '';
}

// Rust has no cross-platform native debugger extension: the Microsoft C++ extension's Windows-only
// cppvsdbg engine understands the PDBs produced by the MSVC-based Rust toolchain, while CodeLLDB is the
// extension VS Code's own docs recommend for macOS/Linux. See:
// https://code.visualstudio.com/docs/languages/rust#_install-debugging-support
const rustDebugAdapter = process.platform === 'win32' ? 'cppvsdbg' : 'lldb';
const rustExtensionId = process.platform === 'win32' ? 'ms-vscode.cpptools' : 'vadimcn.vscode-lldb';

export function createRustDebuggerExtension(rustServiceProducer: (debugSession: AspireDebugSession) => IRustService): ResourceDebuggerExtension {
    return {
        resourceType: 'rust',
        debugAdapter: rustDebugAdapter,
        extensionId: rustExtensionId,
        getDisplayName: (launchConfiguration: ExecutableLaunchConfiguration) => {
            if (isRustLaunchConfiguration(launchConfiguration)) {
                const displayPath = launchConfiguration.working_directory || '';
                return displayPath ? rustDisplayName(vscode.workspace.asRelativePath(displayPath)) : rustLabel;
            }

            return rustLabel;
        },
        getSupportedFileTypes: () => ['.rs'],
        getProjectFile: (launchConfig) => getProjectFile(launchConfig),
        createDebugSessionConfigurationCallback: async (launchConfig, args, _env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
            const config = asRustConfig(launchConfig);
            const workingDirectory = config.working_directory || '';
            const cargoArgs = config.cargo?.args ?? ['build'];

            const rustService = rustServiceProducer(launchOptions.debugSession);
            const executablePath = await rustService.buildAndGetExecutablePath(workingDirectory, cargoArgs, config.cargo?.filter);

            debugConfiguration.program = executablePath;
            debugConfiguration.cwd = workingDirectory;
            debugConfiguration.args = args ?? [];

            if (rustDebugAdapter === 'cppvsdbg') {
                debugConfiguration.console = 'internalConsole';

                // cppvsdbg (and cppdbg) read environment variables from "environment" as a name/value
                // array; they ignore the "env" object that createDebugSessionConfiguration populates for
                // every other debug adapter, so translate it here.
                const env = debugConfiguration.env as Record<string, string | undefined> | undefined;
                debugConfiguration.environment = Object.entries(env ?? {}).map(([name, value]) => ({ name, value: value ?? '' }));
            } else {
                // CodeLLDB already understands the "env" object populated by createDebugSessionConfiguration.
                debugConfiguration.sourceLanguages = ['rust'];
            }
        }
    };
}

export const rustDebuggerExtension: ResourceDebuggerExtension = createRustDebuggerExtension(debugSession => new RustService(debugSession));

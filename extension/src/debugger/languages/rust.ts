import * as vscode from 'vscode';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { getRustExtensionId } from "../../capabilities";
import { AspireResourceExtendedDebugConfiguration, EnvVar, ExecutableLaunchConfiguration, isRustLaunchConfiguration, RustLaunchConfiguration } from "../../dcp/types";
import { invalidLaunchConfiguration, rustBuildFailedWithError, rustBuildFailedWithExitCode, rustBuildProducedMultipleExecutables, rustBuildProducedNoExecutable, rustDisplayName, rustLabel } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";
import { AspireDebugSession } from "../AspireDebugSession";
import { mergeCliSpawnEnvironment } from "./cli";

// cargo's own diagnostic message, emitted once per compiler-message when --message-format=json is used:
//   {"reason":"compiler-message","message":{"rendered":"warning: unused variable...","level":"warning"}}
// The artifact message we actually need looks like:
//   {"reason":"compiler-artifact","target":{"name":"myapp","kind":["bin"]},"executable":"/repo/target/debug/myapp","fresh":false}
// "executable" is only populated for targets that produce a runnable binary (bins, examples, integration
// tests); library-only crates never set it.
export interface CargoCompilerArtifactMessage {
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
    buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], env: EnvVar[]): Promise<string>;
}

// cargo only reports an "executable" for targets that can be run, and those are the target kinds a
// debugger can attach to. Examples are included because `cargo run --example demo` is a normal way to
// launch a crate, and the launch configuration passes the user's cargo arguments through verbatim.
const runnableTargetKinds = ['bin', 'example'];

// Records the executables cargo reported, keyed by target kind and name so a target rebuilt within the
// same run does not look like a second candidate, while a bin and an example sharing a name still do.
export function collectExecutableArtifact(executablesByTarget: Map<string, string>, message: CargoCompilerArtifactMessage): void {
    const targetName = message.target?.name;
    const targetKind = message.target?.kind?.find(kind => runnableTargetKinds.includes(kind));
    if (message.executable && targetName && targetKind) {
        executablesByTarget.set(`${targetKind}/${targetName}`, message.executable);
    }
}

// The debug build runs the same cargo arguments as run mode, so whatever narrows `cargo run` to one
// target (`--bin`, `--example`, `--package`, or a crate with a single binary) narrows this too. The
// one case that can still report several is `default-run`, which `cargo run` honours and `cargo build`
// ignores; report that rather than launching whichever artifact cargo happened to finish last.
export function selectExecutable(workingDirectory: string, executablesByTarget: Map<string, string>): string {
    if (executablesByTarget.size === 0) {
        throw new Error(rustBuildProducedNoExecutable(workingDirectory));
    }

    if (executablesByTarget.size > 1) {
        throw new Error(rustBuildProducedMultipleExecutables(workingDirectory, [...executablesByTarget.keys()].sort().join(', ')));
    }

    return [...executablesByTarget.values()][0];
}

export class RustService implements IRustService {
    private readonly _debugSession: AspireDebugSession;

    constructor(debugSession: AspireDebugSession) {
        this._debugSession = debugSession;
    }

    private writeToDebugConsole(message: string, category: 'stdout' | 'stderr'): void {
        this._debugSession.sendMessage(message, false, category);
    }

    async buildAndGetExecutablePath(workingDirectory: string, cargoArgs: string[], env: EnvVar[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            // --message-format=json lets us reliably discover the compiled binary's absolute path
            // instead of guessing the target/<profile>/<name> layout (which varies with --release,
            // custom target directories, and cross-compilation).
            const args = [...cargoArgs, '--message-format=json'];
            extensionLogOutputChannel.info(`Building Rust application in ${workingDirectory} using: cargo ${args.join(' ')}`);

            // Build with the resource's environment so settings the app host injects (RUSTFLAGS,
            // CARGO_*, proxy variables, and anything set with WithEnvironment) apply to the debug
            // build exactly as they do when DCP runs `cargo run` itself.
            const buildEnv: Record<string, string | undefined> = { ...process.env };
            mergeCliSpawnEnvironment(buildEnv, env);

            const buildProcess = spawn('cargo', args, { cwd: workingDirectory, env: buildEnv });

            // A build can outlive the session that asked for it (cargo waits on its own package lock,
            // and a cold build takes minutes), so stop it when the debug session goes away rather than
            // leaving an orphaned toolchain process holding the target directory lock.
            const cancellation = this._debugSession.registerDisposable({
                dispose: () => {
                    if (buildProcess.exitCode === null && buildProcess.signalCode === null) {
                        extensionLogOutputChannel.info(`Debug session ended; stopping cargo build in ${workingDirectory}.`);
                        buildProcess.kill();
                    }
                }
            });

            // Keyed by target kind and name; see collectExecutableArtifact.
            const executablesByTarget = new Map<string, string>();
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
                    collectExecutableArtifact(executablesByTarget, message as CargoCompilerArtifactMessage);
                }
            });

            buildProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString();
                stderrOutput += output;
                this.writeToDebugConsole(output, 'stderr');
            });

            buildProcess.on('error', err => {
                cancellation.dispose();
                extensionLogOutputChannel.error(`cargo build process error: ${err}`);
                reject(new Error(rustBuildFailedWithError(workingDirectory, err.message)));
            });

            buildProcess.on('close', (code, signal) => {
                cancellation.dispose();

                if (code !== 0) {
                    // A build killed by a signal reports a null exit code, so name the signal instead of
                    // rendering "exit code null". stderr has already been streamed to the debug console,
                    // but repeating it keeps the reason visible in the error notification.
                    const exitDescription = code !== null ? `${code}` : `${signal}`;
                    const error = rustBuildFailedWithExitCode(workingDirectory, exitDescription);
                    reject(new Error(stderrOutput ? `${error}\n${stderrOutput}` : error));
                    return;
                }

                try {
                    resolve(selectExecutable(workingDirectory, executablesByTarget));
                } catch (err) {
                    reject(err);
                }
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
const rustExtensionId = getRustExtensionId();

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
        createDebugSessionConfigurationCallback: async (launchConfig, args, env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
            const config = asRustConfig(launchConfig);
            const workingDirectory = config.working_directory || '';
            const cargoArgs = config.cargo?.args ?? ['build'];

            const rustService = rustServiceProducer(launchOptions.debugSession);
            const executablePath = await rustService.buildAndGetExecutablePath(workingDirectory, cargoArgs, env ?? []);

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

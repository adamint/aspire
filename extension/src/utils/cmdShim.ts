import { terminalCommandArgumentControlCharacters } from '../loc/strings';

/**
 * Shape describing how to launch a command, mirroring the subset of Node's
 * `child_process` options the extension needs to run Windows command shims.
 */
export interface CmdShimSpawnCommand {
    command: string;
    args: string[];
    /** Diagnostic-friendly argument list; the wrapped form is hard to read in logs. */
    diagnosticArgs?: string[];
    windowsVerbatimArguments?: boolean;
}

export function assertNoTerminalControlCharacters(value: string): void {
    // Shell quoting protects shell metacharacters after the command reaches the
    // shell. C0 controls are terminal input first: in sendText fallback, ETX can
    // abort the current line and CR/LF can submit following text as another
    // command before shell parsing can make those bytes inert. Tab is allowed
    // because shells treat it as ordinary whitespace inside quotes.
    if (/[\x00-\x08\x0A-\x1F\x7F]/.test(value)) {
        throw new Error(terminalCommandArgumentControlCharacters);
    }
}

/**
 * Windows `.cmd`/`.bat` shims are batch scripts, not executables. Node refuses to
 * spawn them without a shell since the CVE-2024-27980 fix
 * (https://github.com/nodejs/node/issues/52681), so they must go through cmd.exe.
 */
export function isCommandShimPath(command: string): boolean {
    return /\.(?:cmd|bat)$/i.test(command);
}

export function shouldWrapWithCmd(command: string): boolean {
    return process.platform === 'win32' && isCommandShimPath(command);
}

function getComSpec(): string {
    return process.env.ComSpec ?? 'cmd.exe';
}

function assertNoCmdWrapperControlCharacters(values: readonly string[]): void {
    for (const value of values) {
        assertNoTerminalControlCharacters(value);
    }
}

/**
 * Builds the cmd.exe invocation for a command shim when the caller can set
 * `windowsVerbatimArguments`. The whole command is passed as a single `/c` string
 * that this module quotes itself, which keeps cmd.exe metacharacters inert.
 */
export function getCmdShimSpawnCommand(command: string, args: readonly string[]): CmdShimSpawnCommand {
    const commandArgs = [...args];
    // cmd.exe receives this path as one `/c` command string, not an argv array.
    // Reject terminal controls before quoting so CR/LF and ETX cannot split the wrapper
    // invocation or cancel the command before cmd parsing reaches the quotes.
    assertNoCmdWrapperControlCharacters([command, ...commandArgs]);

    return {
        command: getComSpec(),
        args: ['/d', '/v:off', '/s', '/c', buildCmdWrapperCommand(command, commandArgs)],
        diagnosticArgs: ['call', command, ...commandArgs],
        windowsVerbatimArguments: true,
    };
}

/**
 * Builds the cmd.exe invocation for a command shim when the caller cannot set
 * `windowsVerbatimArguments` — most importantly `McpStdioServerDefinition`, which
 * exposes only `command`/`args` and is spawned by VS Code with `shell: false`
 * (`src/vs/workbench/api/node/extHostMcpNode.ts`).
 *
 * Without verbatim arguments, libuv rebuilds the command line and applies its own
 * quoting, so the single-`/c`-string form used by {@link getCmdShimSpawnCommand}
 * cannot be reused: libuv escapes our embedded quotes as `\"`, which cmd.exe does
 * not understand. The argv form below survives that round trip because libuv quotes
 * each argument individually.
 */
export function getCmdShimSpawnCommandWithoutVerbatimArguments(command: string, args: readonly string[]): CmdShimSpawnCommand {
    const commandArgs = [...args];
    assertNoCmdWrapperControlCharacters([command, ...commandArgs]);

    return {
        command: getComSpec(),
        // `/s` is deliberately omitted: it strips the first and last quote of the whole
        // string after `/c`, which only makes sense for the single-string form above.
        args: ['/d', '/v:off', '/c', 'call', ...[command, ...commandArgs].map(escapeCmdArgumentForLibuvQuoting)],
    };
}

function escapeCmdArgumentForLibuvQuoting(value: string): string {
    // libuv's quote_cmd_arg only wraps an argument in quotes when it contains a space,
    // tab, or quote (https://github.com/libuv/libuv/blob/v1.x/src/win/process.c). When it
    // does, cmd.exe sees a quoted token and metacharacters inside are already inert, so
    // adding carets here would leak literal '^' characters into the path.
    if (/[ \t"]/.test(value)) {
        return value;
    }

    // Otherwise the value reaches cmd.exe unquoted and must escape its own metacharacters.
    // This is the shape that broke global-tool discovery: a DOTNET_CLI_HOME containing '&'
    // has no space, so libuv passed it through and cmd.exe split the path in two.
    // '!' is not escaped because these wrappers always run with `/v:off`.
    return value.replace(/[\^&|<>()]/g, match => `^${match}`);
}

function buildCmdWrapperCommand(command: string, args: string[]): string {
    return ['call', quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(' ');
}

function quoteCmdArgument(value: string): string {
    // The wrapper command is executed as:
    //   cmd.exe /d /v:off /s /c call "aspire.cmd" "<arg>" ...
    // Many .cmd shims then forward arguments to a native executable with `%*`, for example:
    //   "node.exe" "aspire.js" %*
    // Because `%*` is parsed later by normal Windows argv rules, trailing backslashes must be
    // doubled before our closing quote (`"--path=C:\temp\\" "next"`), and backslashes before
    // embedded quotes must be doubled before cmd's doubled-quote escape.
    const valueWithEscapedPercents = value.replace(/%/g, '%%');
    let quotedValue = '';
    let backslashCount = 0;

    for (const character of valueWithEscapedPercents) {
        if (character === '\\') {
            backslashCount++;
            continue;
        }

        if (character === '"') {
            quotedValue += '\\'.repeat(backslashCount * 2);
            backslashCount = 0;
            quotedValue += '""';
            continue;
        }

        quotedValue += '\\'.repeat(backslashCount);
        backslashCount = 0;
        quotedValue += character;
    }

    quotedValue += '\\'.repeat(backslashCount * 2);
    return `"${quotedValue}"`;
}

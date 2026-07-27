import * as vscode from 'vscode';
import { RunSessionInfo } from './dcp/types';

export type Capability =
    | 'prompting' // Support using VS Code to capture user input instead of CLI
    | 'baseline.v1'
    | 'secret-prompts.v1'
    | 'file-pickers.v1'
    | 'build-dotnet-using-cli' // Support building .NET projects using the CLI
    | 'devkit' // Support for .NET DevKit extension (old, used for determining whether to build .NET projects in extension)
    | 'ms-dotnettools.csdevkit' // Older AppHost versions used this extension identifier instead of devkit
    | 'project' // Support for running C# projects
    | 'ms-dotnettools.csharp' // Older AppHost versions used this extension identifier instead of project
    | 'python' // Support for running Python projects
    | 'ms-python.python' // Older AppHost versions used this extension identifier instead of python
    | 'go' // Support for running Go projects
    | 'golang.go' // Older AppHost versions used this extension identifier instead of go
    | 'cppvsdbg' // C++ debugger adapter type used for Rust debugging on Windows
    | 'cppdbg' // C++ debugger adapter type fallback
    | 'rust' // Support for running Rust projects
    | 'rust-lang.rust-analyzer' // Rust Analyzer extension identifier
    | 'vadimcn.vscode-lldb' // CodeLLDB extension identifier
    | 'node' // Support for running Node.js projects
    | 'bun' // Support for running Bun projects
    | 'oven.bun-vscode' // Bun debug adapter extension identifier
    | 'browser' // Support for browser debugging (built-in to VS Code via js-debug)
    | 'maui' // Support for running .NET MAUI projects
    | 'ms-dotnettools.dotnet-maui' // MAUI debug adapter extension identifier
    | 'azure-functions'; // Support for running Azure Functions projects

export type Capabilities = Capability[];
export type RustDebugAdapterType = 'cppvsdbg' | 'cppdbg' | 'lldb' | 'codelldb';

function isExtensionInstalled(extensionId: string): boolean {
    const extension = vscode.extensions.getExtension(extensionId);
    return !!extension;
}

function hasDebuggerType(debuggerType: RustDebugAdapterType): boolean {
    return vscode.extensions.all.some((extension) => {
        const debuggers = (extension.packageJSON as { contributes?: { debuggers?: Array<{ type?: string }> } }).contributes?.debuggers;
        return Array.isArray(debuggers) && debuggers.some(entry => entry.type === debuggerType);
    });
}

export function getRustDebugAdapterType(): RustDebugAdapterType | undefined {
    if (process.platform === 'win32') {
        if (hasDebuggerType('cppvsdbg')) {
            return 'cppvsdbg';
        }

        if (hasDebuggerType('cppdbg')) {
            return 'cppdbg';
        }
    }

    if (hasDebuggerType('lldb') || isExtensionInstalled("vadimcn.vscode-lldb")) {
        return 'lldb';
    }

    if (hasDebuggerType('codelldb')) {
        return 'codelldb';
    }

    return undefined;
}

export function isCsDevKitInstalled() {
    return isExtensionInstalled("ms-dotnettools.csdevkit");
}

export function isCsharpInstalled() {
    return isExtensionInstalled("ms-dotnettools.csharp");
}

export function isPythonInstalled() {
    return isExtensionInstalled("ms-python.python");
}

export function isGoInstalled() {
    return isExtensionInstalled("golang.go");
}

export function isRustInstalled() {
    return getRustDebugAdapterType() !== undefined;
}

export function isAzureFunctionsExtensionInstalled() {
    return isExtensionInstalled("ms-azuretools.vscode-azurefunctions");
}

export function isMauiInstalled() {
    return isExtensionInstalled("ms-dotnettools.dotnet-maui");
}

export function isNodeInstalled() {
    // Node.js debugging uses VS Code's built-in js-debug, no extension needed
    return true;
}

export function isBunInstalled() {
    return isExtensionInstalled("oven.bun-vscode");
}

export function getSupportedCapabilities(): Capabilities {
    const capabilities: Capabilities = ['prompting', 'baseline.v1', 'secret-prompts.v1', 'file-pickers.v1', 'build-dotnet-using-cli'];

    if (isCsDevKitInstalled()) {
        capabilities.push("devkit");
        capabilities.push("ms-dotnettools.csdevkit");
    }

    if (isCsharpInstalled()) {
        capabilities.push("project");
        capabilities.push("ms-dotnettools.csharp");

        // Azure Functions debugging requires both C# (coreclr attach to the worker
        // process) and the Azure Functions extension (to launch func host start).
        if (isAzureFunctionsExtensionInstalled()) {
            capabilities.push("azure-functions");
        }
    }

    if (isPythonInstalled()) {
        capabilities.push("python");
        capabilities.push("ms-python.python");
    }

    if (isGoInstalled()) {
        capabilities.push("go");
        capabilities.push("golang.go");
    }

    if (isRustInstalled()) {
        capabilities.push("rust");

        if (isExtensionInstalled("rust-lang.rust-analyzer")) {
            capabilities.push("rust-lang.rust-analyzer");
        }

        if (isExtensionInstalled("vadimcn.vscode-lldb")) {
            capabilities.push("vadimcn.vscode-lldb");
        }
    }

    if (isNodeInstalled()) {
        capabilities.push("node");
        capabilities.push("browser");
    }

    if (isBunInstalled()) {
        capabilities.push("bun");
        capabilities.push("oven.bun-vscode");
    }

    if (isMauiInstalled()) {
        capabilities.push("maui");
        capabilities.push("ms-dotnettools.dotnet-maui");
    }

    return capabilities;
}

export function getRunSessionInfo(): RunSessionInfo {
    return {
        protocols_supported: ["2024-03-03", "2024-04-23", "2025-10-01"],
        supported_launch_configurations: getSupportedCapabilities()
    };
}

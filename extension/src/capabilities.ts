import * as vscode from 'vscode';
import { RunSessionInfo } from './dcp/types';

export type Capability =
    | 'prompting' // Support using VS Code to capture user input instead of CLI
    | 'baseline.v1'
    | 'secret-prompts.v1'
    | 'file-pickers.v1'
    | 'build-dotnet-using-cli.v2' // Support transferring AppHost build ownership to the CLI
    | 'devkit' // Support for .NET DevKit extension (old, used for determining whether to build .NET projects in extension)
    | 'ms-dotnettools.csdevkit' // Older AppHost versions used this extension identifier instead of devkit
    | 'project' // Support for running C# projects
    | 'ms-dotnettools.csharp' // Older AppHost versions used this extension identifier instead of project
    | 'python' // Support for running Python projects
    | 'ms-python.python' // Older AppHost versions used this extension identifier instead of python
    | 'go' // Support for running Go projects
    | 'golang.go' // Older AppHost versions used this extension identifier instead of go
    | 'node' // Support for running Node.js projects
    | 'bun' // Support for running Bun projects
    | 'oven.bun-vscode' // Bun debug adapter extension identifier
    | 'browser' // Support for browser debugging (built-in to VS Code via js-debug)
    | 'maui' // Support for running .NET MAUI projects
    | 'ms-dotnettools.dotnet-maui' // MAUI debug adapter extension identifier
    | 'azure-functions'; // Support for running Azure Functions projects

export type Capabilities = Capability[];

/**
 * AppHost build ownership capability. Whichever side advertises this promises the AppHost is built
 * exactly once before launch, so the other side skips its own build.
 *
 * The unversioned predecessor ('build-dotnet-using-cli', CLI 13.2.0-13.2.4) could not be trusted:
 * on those CLI versions a no-debug launch forced watch mode, which skipped the CLI pre-build while
 * the CLI still advertised the token. Trusting it meant nobody built and the user silently ran
 * stale output (https://github.com/microsoft/aspire/issues/15850). Never treat the unversioned
 * token as proof that the CLI built.
 */
export const buildDotnetUsingCliCapability = 'build-dotnet-using-cli.v2' satisfies Capability;

function isExtensionInstalled(extensionId: string): boolean {
    const extension = vscode.extensions.getExtension(extensionId);
    return !!extension;
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
    const capabilities: Capabilities = ['prompting', 'baseline.v1', 'secret-prompts.v1', 'file-pickers.v1', buildDotnetUsingCliCapability];

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

import * as vscode from 'vscode';
import { dcpServerInfo, rpcServerInfo } from '../extension';
import { aspireTerminalName } from '../loc/strings';

export function getAspireTerminal(): vscode.Terminal {
    if (!rpcServerInfo) {
        throw new Error('RPC server is not initialized. Ensure activation before using this function.');
    }

    if (!dcpServerInfo) {
        throw new Error('DCP server is not initialized. Ensure activation before using this function.');
    }

    const terminalName = aspireTerminalName;

    const existingTerminal = vscode.window.terminals.find(terminal => terminal.name === terminalName);
    if (existingTerminal) {
        return existingTerminal;
    }
    else {
        const env = { 
            ...process.env, 
            // Include RPC server info
            ASPIRE_EXTENSION_ENDPOINT: rpcServerInfo.address,
            ASPIRE_EXTENSION_TOKEN: rpcServerInfo.token,
            ASPIRE_EXTENSION_CERT: Buffer.from(rpcServerInfo.cert, 'utf-8').toString('base64'),
            ASPIRE_EXTENSION_PROMPT_ENABLED: 'true',
            
            // Use the current locale in the CLI
            ASPIRE_LOCALE_OVERRIDE: vscode.env.language,

            // Include DCP server info
            DEBUG_SESSION_PORT: dcpServerInfo.port.toString(),
            DEBUG_SESSION_TOKEN: dcpServerInfo.token,
            DEBUG_SESSION_SERVER_CERTIFICATE: Buffer.from(dcpServerInfo.certificate, 'utf-8').toString('base64')
         };

        return vscode.window.createTerminal({
            name: terminalName,
            env
        });
    }
}
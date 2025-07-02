import * as vscode from 'vscode';
import { dcpServer, rpcServerInfo } from '../extension';
import { aspireTerminalName } from '../loc/strings';
import { getSupportedDebugLanguages } from './vsc';

export function getAspireTerminal(): vscode.Terminal {
    if (!rpcServerInfo) {
        throw new Error('RPC server is not initialized. Ensure activation before using this function.');
    }

    if (!dcpServer?.info) {
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
            DEBUG_SESSION_PORT: dcpServer.info.address,
            DEBUG_SESSION_TOKEN: dcpServer.info.token,
            //DEBUG_SESSION_SERVER_CERTIFICATE: Buffer.from(dcpServer.info.certificate, 'utf-8').toString('base64')

            // Indicate that this extension supports 
            DEBUG_SESSION_LANGUAGES_SUPPORTED: getSupportedDebugLanguages().join(',')
         };

        return vscode.window.createTerminal({
            name: terminalName,
            env
        });
    }
}
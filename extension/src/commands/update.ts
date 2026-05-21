import { AspireEditorCommandProvider } from '../editor/AspireEditorCommandProvider';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import { getAppHostArgs } from '../utils/appHostArgs';
import { runCliInstallCommand } from './walkthroughCommands';

export async function updateCommand(terminalProvider: AspireTerminalProvider, editorCommandProvider: AspireEditorCommandProvider) {
    const appHostArgs = await getAppHostArgs(editorCommandProvider);
    await terminalProvider.sendAspireCommandToAspireTerminal('update', true, appHostArgs);
}

export async function updateSelfCommand(_terminalProvider: AspireTerminalProvider) {
    // The panel shows this action when the installed CLI may be too old to
    // understand `aspire update --self`, so use the acquisition script instead
    // of routing through the current CLI.
    runCliInstallCommand('daily');
}

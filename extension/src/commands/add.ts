import { AspireEditorCommandProvider } from '../editor/AspireEditorCommandProvider';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import { getAppHostArgs } from '../utils/appHostArgs';
import { getNugetSourceArgs } from '../utils/nugetSource';

export async function addCommand(terminalProvider: AspireTerminalProvider, editorCommandProvider: AspireEditorCommandProvider) {
    const appHostArgs = await getAppHostArgs(editorCommandProvider);
    const nugetSourceArgs = getNugetSourceArgs();
    const additionalArgs = [...(appHostArgs ?? []), ...(nugetSourceArgs ?? [])];

    await terminalProvider.sendAspireCommandToAspireTerminal('add', true, additionalArgs.length > 0 ? additionalArgs : undefined);
}

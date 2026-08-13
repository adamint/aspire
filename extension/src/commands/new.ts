import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import { getNugetSourceArgs } from '../utils/nugetSource';

export async function newCommand(terminalProvider: AspireTerminalProvider) {
    await terminalProvider.sendAspireCommandToAspireTerminal('new', true, getNugetSourceArgs());
}

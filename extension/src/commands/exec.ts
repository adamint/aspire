import { AspireTerminalProvider } from "../utils/AspireTerminalProvider";

export async function execCommand(terminalProvider: AspireTerminalProvider) {
    terminalProvider.sendAspireCommandToAspireTerminal('exec');
}
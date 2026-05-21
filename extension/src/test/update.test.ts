import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { updateSelfCommand } from '../commands/update';
import { getCliInstallCommand } from '../commands/walkthroughCommands';
import { AspireTerminalProvider } from '../utils/AspireTerminalProvider';
import { aspireTerminalName } from '../loc/strings';

suite('commands/update', () => {
    test('updateSelfCommand uses installer instead of requiring the installed CLI to support self update', async () => {
        const sentTexts: string[] = [];
        let shown = false;
        const terminal = {
            name: aspireTerminalName,
            show: () => { shown = true; },
            sendText: (text: string) => { sentTexts.push(text); },
        } as unknown as vscode.Terminal;
        const terminalsStub = sinon.stub(vscode.window, 'terminals').value([]);
        const createTerminalStub = sinon.stub(vscode.window, 'createTerminal').returns(terminal);
        const terminalProvider = {
            sendAspireCommandToAspireTerminal: sinon.stub().resolves(),
        } as unknown as AspireTerminalProvider;

        try {
            await updateSelfCommand(terminalProvider);

            assert.strictEqual(shown, true);
            assert.deepStrictEqual(sentTexts, [getCliInstallCommand('daily')]);
            assert.strictEqual((terminalProvider.sendAspireCommandToAspireTerminal as sinon.SinonStub).called, false);
            assert.strictEqual(createTerminalStub.calledOnce, true);
        }
        finally {
            terminalsStub.restore();
            createTerminalStub.restore();
        }
    });
});

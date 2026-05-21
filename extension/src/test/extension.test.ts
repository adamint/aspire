import * as assert from 'assert';
import { commandRequiresCliAvailability } from '../extension';

suite('extension command registration', () => {
    test('updateSelf does not require an already usable CLI', () => {
        assert.strictEqual(commandRequiresCliAvailability('aspire-vscode.updateSelf'), false);
    });

    test('regular CLI commands still require CLI availability', () => {
        assert.strictEqual(commandRequiresCliAvailability('aspire-vscode.add'), true);
    });
});

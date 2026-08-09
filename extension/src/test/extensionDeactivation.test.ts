import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Extension deactivation', () => {
    test('returns the Aspire context shutdown promise to VS Code', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const extensionSource = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
        const deactivateStart = extensionSource.indexOf('export function deactivate(): Promise<void>');
        assert.ok(deactivateStart >= 0);

        const deactivateBody = extensionSource.slice(deactivateStart, extensionSource.indexOf('\n}', deactivateStart) + 2);
        assert.ok(deactivateBody.includes('return aspireExtensionContext.deactivate();'));
    });
});

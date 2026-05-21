import * as assert from 'assert';
import { getCliInstallCommand } from '../commands/walkthroughCommands';

suite('walkthroughCommands', () => {
    suite('getCliInstallCommand', () => {
        test('returns Windows PowerShell stable installer command', () => {
            assert.strictEqual(getCliInstallCommand('stable', 'win32'), 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://aspire.dev/install.ps1\' | iex"');
        });

        test('returns Windows PowerShell daily installer command', () => {
            assert.strictEqual(getCliInstallCommand('daily', 'win32'), 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm \'https://aspire.dev/install.ps1\'))) -Quality dev"');
        });

        test('returns Unix stable installer command', () => {
            assert.strictEqual(getCliInstallCommand('stable', 'linux'), 'curl -sSL https://aspire.dev/install.sh | bash');
        });

        test('returns Unix daily installer command', () => {
            assert.strictEqual(getCliInstallCommand('daily', 'darwin'), 'curl -sSL https://aspire.dev/install.sh | bash -s -- -q dev');
        });
    });
});

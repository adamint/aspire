import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// TEMPORARY DIAGNOSTIC — determines which cmd.exe wrapper shape actually launches a
// command shim whose absolute path contains cmd.exe metacharacters. Removed once the
// working shape is known.
suite('cmd shim shape diagnostic', () => {
    test('reports which wrapper shapes launch a metacharacter shim', async function () {
        if (process.platform !== 'win32') {
            this.skip();
        }

        this.timeout(120000);

        const comSpec = process.env.ComSpec ?? 'cmd.exe';
        const dirs = {
            amp: 'aspire-amp&x-',
            caret: 'aspire-caret^x-',
            paren: 'aspire-paren(x)-',
            space: 'aspire space-',
        };

        const q = (v: string) => `"${v}"`;
        const shapes: Record<string, (p: string) => { args: string[]; verbatim: boolean }> = {
            'A verbatim /s /c call "P"': p => ({ args: ['/d', '/v:off', '/s', '/c', `call ${q(p)} ${q('--version')}`], verbatim: true }),
            'B verbatim /s /c "P"': p => ({ args: ['/d', '/v:off', '/s', '/c', `${q(p)} ${q('--version')}`], verbatim: true }),
            'C verbatim /c call "P"': p => ({ args: ['/d', '/v:off', '/c', `call ${q(p)} ${q('--version')}`], verbatim: true }),
            'D verbatim /s /c OUTER("call "P"")': p => ({ args: ['/d', '/v:off', '/s', '/c', `"call ${q(p)} ${q('--version')}"`], verbatim: true }),
            'E verbatim /s /c OUTER(""P"")': p => ({ args: ['/d', '/v:off', '/s', '/c', `"${q(p)} ${q('--version')}"`], verbatim: true }),
            'F argv /d /c call P': p => ({ args: ['/d', '/c', 'call', p, '--version'], verbatim: false }),
            'G argv /d /c P': p => ({ args: ['/d', '/c', p, '--version'], verbatim: false }),
        };

        const lines: string[] = [];
        for (const [dirName, prefix] of Object.entries(dirs)) {
            const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
            try {
                const wrapperPath = path.join(tempDirectory, 'aspire.cmd');
                fs.writeFileSync(wrapperPath, '@echo off\r\nif "%~1"=="--version" (\r\n  echo 13.5.0-pr.e2e\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n');
                lines.push(`DIR[${dirName}] ${tempDirectory}`);

                for (const [shapeName, build] of Object.entries(shapes)) {
                    const { args, verbatim } = build(wrapperPath);
                    let outcome: string;
                    try {
                        const { stdout } = await execFileAsync(comSpec, args, { timeout: 15000, windowsVerbatimArguments: verbatim });
                        outcome = `OK   out=${JSON.stringify(String(stdout).trim().slice(0, 40))}`;
                    }
                    catch (error) {
                        const e = error as { code?: unknown; message?: string; stderr?: string };
                        outcome = `FAIL code=${String(e.code)} err=${JSON.stringify(String(e.stderr ?? e.message ?? '').trim().slice(0, 80))}`;
                    }
                    lines.push(`  RESULT[${dirName}] ${shapeName} -> ${outcome}`);
                }
            }
            finally {
                fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
            }
        }

        console.log('\n===== CMDSHIM-DIAG BEGIN =====\n' + lines.join('\n') + '\n===== CMDSHIM-DIAG END =====\n');
        assert.ok(lines.length > 0);
    });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCanonicalPath } from '../utils/io';

suite('utils/io tests', () => {

    test('resolveCanonicalPath returns canonical casing for existing file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-test-'));

        // Resolve tmpDir itself first so symlinks (e.g., /var -> /private/var on macOS)
        // don't interfere with comparisons
        const canonicalTmpDir = fs.realpathSync.native(tmpDir);
        const filePath = path.join(canonicalTmpDir, 'MyAppHost.csproj');
        fs.writeFileSync(filePath, '');

        try {
            const resolved = resolveCanonicalPath(filePath);

            assert.ok(fs.existsSync(resolved), 'Resolved path should exist');
            assert.ok(path.isAbsolute(resolved), 'Resolved path should be absolute');
            assert.strictEqual(resolved, filePath, 'Canonical path should match when input casing is already correct');
        } finally {
            fs.unlinkSync(filePath);
            fs.rmdirSync(canonicalTmpDir);
        }
    });

    test('resolveCanonicalPath resolves wrong-cased path on case-insensitive filesystem', function () {
        // This test is meaningful only on case-insensitive file systems (macOS, Windows)
        if (process.platform === 'linux') {
            this.skip();
            return;
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-test-'));
        const canonicalTmpDir = fs.realpathSync.native(tmpDir);
        const filePath = path.join(canonicalTmpDir, 'MyAppHost.csproj');
        fs.writeFileSync(filePath, '');

        try {
            // Pass a wrong-cased version of the path
            const wrongCased = path.join(canonicalTmpDir, 'myapphost.csproj');
            const resolved = resolveCanonicalPath(wrongCased);

            // On case-insensitive FS, realpathSync.native returns the actual on-disk casing
            assert.strictEqual(path.basename(resolved), 'MyAppHost.csproj',
                `Expected resolved path to have on-disk casing "MyAppHost.csproj", got "${path.basename(resolved)}"`);
            assert.strictEqual(resolved, filePath, 'Full resolved path should match the on-disk canonical path');
        } finally {
            fs.unlinkSync(filePath);
            fs.rmdirSync(canonicalTmpDir);
        }
    });

    test('resolveCanonicalPath returns original path for non-existent file', () => {
        const fakePath = path.join(os.tmpdir(), 'non-existent-dir-15588', 'DoesNotExist.csproj');
        const resolved = resolveCanonicalPath(fakePath);

        assert.strictEqual(resolved, fakePath, 'Should return original path when file does not exist');
    });

    test('resolveCanonicalPath handles symlinks', function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-test-'));
        const canonicalTmpDir = fs.realpathSync.native(tmpDir);
        const realFile = path.join(canonicalTmpDir, 'RealFile.csproj');
        const symlink = path.join(canonicalTmpDir, 'SymLink.csproj');

        fs.writeFileSync(realFile, '');

        try {
            fs.symlinkSync(realFile, symlink);
        } catch {
            // Symlinks may not be available (e.g., some Windows configs)
            this.skip();
            return;
        }

        try {
            const resolved = resolveCanonicalPath(symlink);
            assert.ok(resolved.endsWith('RealFile.csproj'),
                `Expected symlink to resolve to "RealFile.csproj", got "${path.basename(resolved)}"`);
        } finally {
            fs.unlinkSync(symlink);
            fs.unlinkSync(realFile);
            fs.rmdirSync(canonicalTmpDir);
        }
    });

    test('resolveCanonicalPath handles directory paths', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-test-'));
        const canonicalTmpDir = fs.realpathSync.native(tmpDir);

        try {
            const resolved = resolveCanonicalPath(canonicalTmpDir);
            assert.ok(fs.existsSync(resolved), 'Resolved directory path should exist');
            assert.ok(path.isAbsolute(resolved), 'Resolved directory path should be absolute');
        } finally {
            fs.rmdirSync(canonicalTmpDir);
        }
    });

    test('resolveCanonicalPath normalizes parent directory casing on case-insensitive filesystem', function () {
        // Verifies that case normalization works for parent directories too,
        // not just the filename component
        if (process.platform === 'linux') {
            this.skip();
            return;
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'AspireTestDir-'));
        const canonicalTmpDir = fs.realpathSync.native(tmpDir);
        const subDir = path.join(canonicalTmpDir, 'SubFolder');
        fs.mkdirSync(subDir);
        const filePath = path.join(subDir, 'AppHost.csproj');
        fs.writeFileSync(filePath, '');

        try {
            // Construct a path with wrong casing in both directory and file name
            const wrongCased = path.join(canonicalTmpDir, 'subfolder', 'apphost.csproj');
            const resolved = resolveCanonicalPath(wrongCased);

            assert.ok(resolved.includes('SubFolder'), `Expected "SubFolder" in resolved path, got "${resolved}"`);
            assert.ok(resolved.endsWith('AppHost.csproj'), `Expected "AppHost.csproj" at end, got "${path.basename(resolved)}"`);
        } finally {
            fs.unlinkSync(filePath);
            fs.rmdirSync(subDir);
            fs.rmdirSync(canonicalTmpDir);
        }
    });
});

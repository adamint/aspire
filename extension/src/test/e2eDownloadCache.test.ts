import * as assert from 'assert';
import * as fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(extensionRoot, '..');
const testArtifactsRoot = path.join(extensionRoot, '.test-artifacts', 'e2e-download-cache-tests');
const ambientGitLocationKeys = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;
const ambientGitLocationKeySet = new Set<string>(ambientGitLocationKeys);
const createdTestRoots: string[] = [];

type GitRunnerResult = {
    error?: Error;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
};

type GitRunner = (command: string, args: readonly string[], options: {
    encoding: 'utf8';
    shell: false;
    env?: NodeJS.ProcessEnv;
}) => GitRunnerResult;

type CacheManifest = {
    schemaVersion: number;
    platform: NodeJS.Platform;
    architecture: string;
    vscodeVersion: string;
    extesterVersion: string;
    vscodeDirectory: string;
    chromeDriverEntry: string;
    chromeDriverBinary: string;
};

type EnsureDownloadCacheOptions = {
    cacheRoot: string;
    vscodeVersion: string;
    extesterVersion: string;
    platform?: NodeJS.Platform;
    architecture?: string;
    populate(stagingDirectory: string): void;
};

type EnsureDownloadCacheResult = {
    cacheDirectory: string;
    cacheHit: boolean;
    manifest: CacheManifest;
};

type DownloadLayout = 'legacy' | 'current';

type PopulateFakeDownloadOptions = {
    platform: NodeJS.Platform;
    architecture: string;
    driverLayout?: DownloadLayout;
    includeArchives?: boolean;
    extraCurrentDriverDirectories?: string[];
};

const cache = require(path.join(extensionRoot, 'scripts', 'e2e-download-cache.js')) as {
    CACHE_SCHEMA_VERSION: number;
    CACHE_MANIFEST_NAME: string;
    resolveDownloadCacheRoot(repoRoot: string, environment?: NodeJS.ProcessEnv): string;
    getDownloadCacheEntryDirectory(cacheRoot: string, options: {
        platform: NodeJS.Platform;
        architecture: string;
        vscodeVersion: string;
        extesterVersion: string;
    }): string;
    ensureDownloadCache(options: EnsureDownloadCacheOptions): EnsureDownloadCacheResult;
    projectDownloadCache(result: EnsureDownloadCacheResult, storageDirectory: string): void;
    __testOnly__?: {
        resolveGitCommonDir(repoRoot: string, gitRunner?: GitRunner, environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
        assertCacheEntryTreeIsContained(cacheDirectory: string): void;
        discoverCacheArtifacts(rootDirectory: string, platform: NodeJS.Platform, architecture: string): {
            vscodeDirectory: string;
            chromeDriverEntry: string;
            chromeDriverBinary: string;
        };
        encodePathSegment(value: string): string;
        mergeEnvironment(baseEnvironment: NodeJS.ProcessEnv, overrideEnvironment: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
    };
};

function withEnvironment(overrides: NodeJS.ProcessEnv, callback: () => void): void {
    const previousValues = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(overrides)) {
        previousValues.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        callback();
    } finally {
        for (const [key, value] of previousValues) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function getSanitizedGitEnvironment(environment: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const sanitizedEnvironment = {
        ...process.env,
        ...environment,
    };

    for (const key of Object.keys(sanitizedEnvironment)) {
        if (ambientGitLocationKeySet.has(key.toUpperCase())) {
            delete sanitizedEnvironment[key];
        }
    }

    return sanitizedEnvironment;
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
    if (!environment) {
        return undefined;
    }

    const entry = Object.entries(environment).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    return entry?.[1];
}

function createTestRoot(name: string): string {
    fs.mkdirSync(testArtifactsRoot, { recursive: true });
    const sanitizedName = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const root = fs.mkdtempSync(path.join(testArtifactsRoot, `${sanitizedName}-`));
    createdTestRoots.push(root);
    return root;
}

function getDefaultCacheOptions(cacheRoot: string, overrides: Partial<Omit<EnsureDownloadCacheOptions, 'cacheRoot' | 'vscodeVersion' | 'extesterVersion' | 'populate'>> & {
    populate(stagingDirectory: string): void;
}): EnsureDownloadCacheOptions {
    return {
        cacheRoot,
        vscodeVersion: '1.122.1',
        extesterVersion: '8.23.0',
        platform: 'linux',
        architecture: 'x64',
        ...overrides,
    };
}

function ensureParentDirectory(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFile(filePath: string, content = ''): void {
    ensureParentDirectory(filePath);
    fs.writeFileSync(filePath, content);
}

function setPathModifiedTime(candidatePath: string, modifiedTime: Date): void {
    fs.utimesSync(candidatePath, modifiedTime, modifiedTime);
}

function createDirectoryLink(linkPath: string, targetPath: string): void {
    ensureParentDirectory(linkPath);

    try {
        fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        throw new Error(`Test setup failed: unable to create ${process.platform === 'win32' ? 'junction' : 'directory symlink'} '${linkPath}' -> '${targetPath}': ${error instanceof Error ? error.message : String(error)}`);
    }

    let linkStats: fs.Stats;
    try {
        linkStats = fs.lstatSync(linkPath);
    } catch (error) {
        throw new Error(`Test setup failed: unable to lstat linked directory '${linkPath}': ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!linkStats.isSymbolicLink()) {
        throw new Error(`Test setup failed: expected '${linkPath}' to be a symbolic link or junction.`);
    }
}

function createFileLink(linkPath: string, targetPath: string): void {
    ensureParentDirectory(linkPath);

    try {
        if (process.platform === 'win32') {
            fs.linkSync(targetPath, linkPath);
        } else {
            fs.symlinkSync(targetPath, linkPath, 'file');
        }
    } catch (error) {
        throw new Error(`Test setup failed: unable to create ${process.platform === 'win32' ? 'hard link' : 'file symlink'} '${linkPath}' -> '${targetPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

function createHardFileLink(linkPath: string, targetPath: string): void {
    ensureParentDirectory(linkPath);
    fs.linkSync(targetPath, linkPath);
}

function getVsCodeDirectoryName(platform: NodeJS.Platform, architecture: string): string {
    switch (platform) {
        case 'darwin':
            return 'Visual Studio Code.app';
        case 'linux':
            return `VSCode-linux-${architecture}`;
        case 'win32':
            if (architecture !== 'x64' && architecture !== 'arm64') {
                throw new Error(`Unsupported VS Code platform/architecture combination: ${platform}/${architecture}.`);
            }
            return `VSCode-win32-${architecture}-archive`;
        default:
            throw new Error(`Unsupported VS Code platform/architecture combination: ${platform}/${architecture}.`);
    }
}

function getVsCodeExecutableRelativePath(platform: NodeJS.Platform, architecture: string): string {
    const vscodeDirectory = getVsCodeDirectoryName(platform, architecture);

    switch (platform) {
        case 'darwin':
            return path.join(vscodeDirectory, 'Contents', 'MacOS', 'Electron');
        case 'linux':
            return path.join(vscodeDirectory, 'code');
        case 'win32':
            return path.join(vscodeDirectory, 'Code.exe');
        default:
            throw new Error(`Unsupported VS Code platform/architecture combination: ${platform}/${architecture}.`);
    }
}

function getChromeDriverBinaryName(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
}

function populateFakeDownload(stagingDirectory: string, options: PopulateFakeDownloadOptions): {
    vscodeDirectory: string;
    chromeDriverEntry: string;
    chromeDriverBinary: string;
} {
    const driverLayout = options.driverLayout ?? 'current';
    const vscodeDirectory = getVsCodeDirectoryName(options.platform, options.architecture);
    const vscodeExecutableRelativePath = getVsCodeExecutableRelativePath(options.platform, options.architecture);
    const chromeDriverBinaryName = getChromeDriverBinaryName(options.platform);

    writeFile(path.join(stagingDirectory, vscodeExecutableRelativePath), 'fake vscode executable');

    if (options.includeArchives) {
        writeFile(path.join(stagingDirectory, 'vscode-download.zip'), 'fake vscode archive');
        writeFile(path.join(stagingDirectory, 'chromedriver-download.tgz'), 'fake driver archive');
    }

    let chromeDriverEntry: string;
    let chromeDriverBinary: string;

    if (driverLayout === 'legacy') {
        chromeDriverEntry = chromeDriverBinaryName;
        chromeDriverBinary = chromeDriverBinaryName;
        writeFile(path.join(stagingDirectory, chromeDriverBinaryName), 'legacy chromedriver');
    } else {
        chromeDriverEntry = `chromedriver-${options.platform}-${options.architecture}`;
        chromeDriverBinary = path.join(chromeDriverEntry, chromeDriverBinaryName);
        writeFile(path.join(stagingDirectory, chromeDriverBinary), 'current chromedriver');

        for (const extraDirectory of options.extraCurrentDriverDirectories ?? []) {
            writeFile(path.join(stagingDirectory, extraDirectory, chromeDriverBinaryName), 'extra chromedriver');
        }
    }

    return {
        vscodeDirectory,
        chromeDriverEntry,
        chromeDriverBinary,
    };
}

function writeCacheManifest(cacheDirectory: string, manifest: CacheManifest): void {
    writeFile(path.join(cacheDirectory, cache.CACHE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

function publishValidCacheEntry(cacheDirectory: string, options: {
    platform: NodeJS.Platform;
    architecture: string;
    vscodeVersion: string;
    extesterVersion: string;
    markerFileName?: string;
}): CacheManifest {
    const discoveredArtifacts = populateFakeDownload(cacheDirectory, {
        platform: options.platform,
        architecture: options.architecture,
    });
    const manifest: CacheManifest = {
        schemaVersion: cache.CACHE_SCHEMA_VERSION,
        platform: options.platform,
        architecture: options.architecture,
        vscodeVersion: options.vscodeVersion,
        extesterVersion: options.extesterVersion,
        ...discoveredArtifacts,
    };

    if (options.markerFileName) {
        writeFile(path.join(cacheDirectory, options.markerFileName), options.markerFileName);
    }

    writeCacheManifest(cacheDirectory, manifest);
    return manifest;
}

function readManifest(cacheDirectory: string): CacheManifest {
    return JSON.parse(fs.readFileSync(path.join(cacheDirectory, cache.CACHE_MANIFEST_NAME), 'utf8')) as CacheManifest;
}


function getEntrySiblingNames(entryDirectory: string, prefix: string): string[] {
    const entryParentDirectory = path.dirname(entryDirectory);
    if (!fs.existsSync(entryParentDirectory)) {
        return [];
    }

    return fs.readdirSync(entryParentDirectory)
        .filter((entry) => entry.startsWith(prefix))
        .sort();
}

function getStagingSiblingNames(entryDirectory: string): string[] {
    return getEntrySiblingNames(entryDirectory, `${path.basename(entryDirectory)}-staging-`);
}

function getDiscardedSiblingNames(entryDirectory: string): string[] {
    return getEntrySiblingNames(entryDirectory, `${path.basename(entryDirectory)}.discarded-`);
}

function assertNoStagingSiblings(entryDirectory: string): void {
    assert.deepStrictEqual(getStagingSiblingNames(entryDirectory), []);
}

async function waitForPaths(pathsToCheck: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
        if (pathsToCheck.every((candidate) => fs.existsSync(candidate))) {
            return;
        }

        await delay(25);
    }

    throw new Error(`Timed out waiting for ${pathsToCheck.join(', ')}.`);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function spawnWorker(scriptPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EnsureDownloadCacheResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    return new Promise<EnsureDownloadCacheResult>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
            cwd: extensionRoot,
            env: {
                ...process.env,
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`Timed out waiting for child process ${child.pid ?? 'unknown'}. stderr: ${stderr}`));
        }, timeoutMs);

        child.on('error', (error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            reject(error);
        });

        child.on('close', (code, signal) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            if (code !== 0) {
                reject(new Error(`Child process exited with code ${code ?? 'null'} signal ${signal ?? 'null'}: ${stderr}`));
                return;
            }

            try {
                resolve(JSON.parse(stdout.trim()) as EnsureDownloadCacheResult);
            } catch (error) {
                reject(new Error(`Unable to parse child stdout as JSON. stdout: ${stdout}\nstderr: ${stderr}\n${error instanceof Error ? error.message : String(error)}`));
            }
        });
    });
}

function createRaceWorkerScript(workerRoot: string): string {
    const scriptPath = path.join(workerRoot, 'ensure-download-cache-worker.js');
    const cacheModulePath = path.join(extensionRoot, 'scripts', 'e2e-download-cache.js');

    fs.writeFileSync(scriptPath, `'use strict';
const fs = require('fs');
const path = require('path');
const cache = require(${JSON.stringify(cacheModulePath)});

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const readyPath = process.env.READY_PATH;
const goPath = process.env.GO_PATH;
const counterFile = process.env.COUNTER_FILE;
const cacheRoot = process.env.CACHE_ROOT;
const populateDelayMs = Number(process.env.POPULATE_DELAY_MS || '0');

writeFile(readyPath, String(process.pid));
while (!fs.existsSync(goPath)) {
  sleep(10);
}

const result = cache.ensureDownloadCache({
  cacheRoot,
  vscodeVersion: '1.122.1',
  extesterVersion: '8.23.0',
  platform: 'linux',
  architecture: 'x64',
  populate(stagingDirectory) {
    writeFile(path.join(stagingDirectory, 'VSCode-linux-x64', 'code'), 'fake vscode executable');
    writeFile(path.join(stagingDirectory, 'chromedriver-linux-x64', 'chromedriver'), 'fake chromedriver');

    const fileHandle = fs.openSync(counterFile, 'a');
    try {
      fs.writeSync(fileHandle, process.pid + '\\n');
    } finally {
      fs.closeSync(fileHandle);
    }

    sleep(populateDelayMs);
  }
});

process.stdout.write(JSON.stringify(result));
`, 'utf8');

    return scriptPath;
}

function readPopulationCount(counterFile: string): number {
    if (!fs.existsSync(counterFile)) {
        return 0;
    }

    return fs.readFileSync(counterFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .length;
}

suite('E2E download cache', () => {
    teardown(() => {
        while (createdTestRoots.length > 0) {
            const root = createdTestRoots.pop();
            if (root) {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    });

    test('uses the repository git common dir as the default cache root', () => {
        const gitEnvironment = getSanitizedGitEnvironment();
        const gitCommonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: gitEnvironment }).trim();
        const cacheRoot = cache.resolveDownloadCacheRoot(repoRoot, {});

        assert.strictEqual(cache.CACHE_SCHEMA_VERSION, 1);
        assert.strictEqual(cache.CACHE_MANIFEST_NAME, 'cache-manifest.json');
        assert.strictEqual(cacheRoot, path.join(gitCommonDir, 'aspire-extension-e2e-cache'));
    });

    test('sanitizes ambient git repository location variables before invoking git', () => {
        const resolveGitCommonDir = cache.__testOnly__?.resolveGitCommonDir;

        assert.strictEqual(typeof resolveGitCommonDir, 'function');

        withEnvironment({
            GIT_DIR: path.join(repoRoot, '.git'),
            GIT_WORK_TREE: repoRoot,
            GIT_COMMON_DIR: path.join(repoRoot, '.git', 'objects'),
            GIT_INDEX_FILE: path.join(repoRoot, '.git', 'index'),
            GIT_OBJECT_DIRECTORY: path.join(repoRoot, '.git', 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repoRoot, '.git', 'alt-objects'),
            GIT_CEILING_DIRECTORIES: repoRoot,
            GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
        }, () => {
            let capturedOptions: {
                encoding: 'utf8';
                shell: false;
                env?: NodeJS.ProcessEnv;
            } | undefined;

            const gitCommonDir = resolveGitCommonDir!('/repo', (command, args, options) => {
                capturedOptions = options;
                return {
                    status: 0,
                    signal: null,
                    stdout: '/shared/git/common-dir\n',
                    stderr: '',
                };
            }, {
                ASPIRE_EXTENSION_E2E_CACHE_ROOT: '',
                SENTINEL_UNRELATED_VARIABLE: 'keep-me',
            });

            assert.strictEqual(gitCommonDir, '/shared/git/common-dir');
            assert.strictEqual(capturedOptions?.encoding, 'utf8');
            assert.strictEqual(capturedOptions?.shell, false);
            assert.ok(capturedOptions?.env);

            for (const key of ambientGitLocationKeys) {
                assert.ok(!(key in (capturedOptions?.env ?? {})), `${key} should be removed from the child Git environment`);
            }
            assert.strictEqual(capturedOptions?.env?.SENTINEL_UNRELATED_VARIABLE, 'keep-me');
            assert.strictEqual(getEnvironmentValue(capturedOptions?.env, 'PATH'), process.env.PATH);
            assert.strictEqual(getEnvironmentValue(capturedOptions?.env, 'HOME'), process.env.HOME);
        });
    });

    test('sanitizes mixed-case ambient git repository location variables before invoking git', () => {
        const resolveGitCommonDir = cache.__testOnly__?.resolveGitCommonDir;

        assert.strictEqual(typeof resolveGitCommonDir, 'function');

        withEnvironment({
            Git_Dir: path.join(repoRoot, '.git'),
            git_work_tree: repoRoot,
            gIt_CeIlInG_dIrEcToRiEs: repoRoot,
        }, () => {
            let capturedOptions: {
                encoding: 'utf8';
                shell: false;
                env?: NodeJS.ProcessEnv;
            } | undefined;

            const gitCommonDir = resolveGitCommonDir!('/repo', (command, args, options) => {
                capturedOptions = options;
                return {
                    status: 0,
                    signal: null,
                    stdout: '/shared/git/common-dir\n',
                    stderr: '',
                };
            }, {
                SENTINEL_UNRELATED_VARIABLE: 'keep-me',
            });

            assert.strictEqual(gitCommonDir, '/shared/git/common-dir');
            assert.strictEqual(capturedOptions?.encoding, 'utf8');
            assert.strictEqual(capturedOptions?.shell, false);
            assert.ok(capturedOptions?.env);

            for (const key of ['Git_Dir', 'git_work_tree', 'gIt_CeIlInG_dIrEcToRiEs']) {
                assert.ok(!(key in (capturedOptions?.env ?? {})), `${key} should be removed from the child Git environment`);
            }

            assert.strictEqual(capturedOptions?.env?.SENTINEL_UNRELATED_VARIABLE, 'keep-me');
        });
    });

    test('merges child git environment overrides case-insensitively on Windows', () => {
        const resolveGitCommonDir = cache.__testOnly__?.resolveGitCommonDir;

        assert.strictEqual(typeof resolveGitCommonDir, 'function');

        let capturedOptions: {
            encoding: 'utf8';
            shell: false;
            env?: NodeJS.ProcessEnv;
        } | undefined;

        const gitCommonDir = resolveGitCommonDir!('/repo', (command, args, options) => {
            capturedOptions = options;
            return {
                status: 0,
                signal: null,
                stdout: '/shared/git/common-dir\n',
                stderr: '',
            };
        }, {
            Path: 'sentinel-path',
            HOME: undefined,
            Sentinel_Value: 'kept',
        }, 'win32');

        assert.strictEqual(gitCommonDir, '/shared/git/common-dir');
        assert.strictEqual(capturedOptions?.encoding, 'utf8');
        assert.strictEqual(capturedOptions?.shell, false);
        assert.ok(capturedOptions?.env);

        const capturedEnvironment = capturedOptions?.env ?? {};
        const pathKeys = Object.keys(capturedEnvironment).filter((key) => key.toLowerCase() === 'path');
        const homeKeys = Object.keys(capturedEnvironment).filter((key) => key.toLowerCase() === 'home');

        assert.deepStrictEqual(pathKeys, ['Path']);
        assert.strictEqual(capturedEnvironment.Path, 'sentinel-path');
        assert.strictEqual(capturedEnvironment.PATH, undefined);
        assert.deepStrictEqual(homeKeys, []);
        assert.strictEqual(capturedEnvironment.Sentinel_Value, 'kept');
    });

    test('honors ASPIRE_EXTENSION_E2E_CACHE_ROOT as an absolute path override', () => {
        const overrideRoot = path.resolve('relative-cache-root');

        assert.strictEqual(cache.resolveDownloadCacheRoot(repoRoot, {
            ASPIRE_EXTENSION_E2E_CACHE_ROOT: './relative-cache-root',
        }), overrideRoot);
    });

    test('includes actionable git failure details when the repo root path does not exist', () => {
        const parentDirectory = createTestRoot('invalid-root');
        const invalidRepoRoot = path.join(parentDirectory, 'missing-repo-root');

        assert.throws(() => cache.resolveDownloadCacheRoot(invalidRepoRoot, {}), (error: unknown) => {
            if (!(error instanceof Error)) {
                return false;
            }

            assert.ok(error.message.includes('ASPIRE_EXTENSION_E2E_CACHE_ROOT'));
            assert.match(error.message, /Git exited with code [1-9]\d*/);
            return true;
        });
    });

    test('includes stderr details when git resolves an empty cache root', () => {
        const resolveGitCommonDir = cache.__testOnly__?.resolveGitCommonDir;

        assert.strictEqual(typeof resolveGitCommonDir, 'function');

        assert.throws(() => resolveGitCommonDir!('/repo', () => ({
            status: 0,
            signal: null,
            stdout: '',
            stderr: 'warning: reused stale output',
        })), (error: unknown) => {
            if (!(error instanceof Error)) {
                return false;
            }

            assert.ok(error.message.includes('/repo'));
            assert.ok(error.message.includes('warning: reused stale output'));
            assert.ok(error.message.includes('Git exited with code 0'));
            assert.ok(error.message.includes('ASPIRE_EXTENSION_E2E_CACHE_ROOT'));
            return true;
        });
    });

    test('invokes git with git common dir flags and a fixed utf8 shell-free runner contract', () => {
        const calls: Array<{
            command: string;
            args: readonly string[];
            options: { encoding: 'utf8'; shell: false; env?: NodeJS.ProcessEnv };
        }> = [];
        const resolveGitCommonDir = cache.__testOnly__?.resolveGitCommonDir;

        assert.strictEqual(typeof resolveGitCommonDir, 'function');

        const gitCommonDir = resolveGitCommonDir!('/repo', (command, args, options) => {
            calls.push({ command, args, options });
            return {
                status: 0,
                signal: null,
                stdout: '/shared/git/common-dir\n',
                stderr: '',
            };
        });

        assert.strictEqual(gitCommonDir, '/shared/git/common-dir');
        assert.deepStrictEqual(calls, [{
            command: 'git',
            args: ['-C', '/repo', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            options: {
                encoding: 'utf8',
                shell: false,
                env: getSanitizedGitEnvironment(),
            },
        }]);
    });

    test('__testOnly__ exports the supported helper surface exactly', () => {
        assert.deepStrictEqual(Object.keys(cache.__testOnly__ ?? {}).sort(), [
            'assertCacheEntryTreeIsContained',
            'discoverCacheArtifacts',
            'encodePathSegment',
            'mergeEnvironment',
            'resolveGitCommonDir',
        ]);
    });

    test('partitions cache entries by schema, platform, architecture, version, and sanitizes unsafe characters', () => {
        const entryDirectory = cache.getDownloadCacheEntryDirectory('/cache-root', {
            platform: 'win32',
            architecture: 'arm64',
            vscodeVersion: '1.122.1/insiders',
            extesterVersion: '8.23.0/alpha',
        });

        const slashVersionDirectory = cache.getDownloadCacheEntryDirectory('/cache-root', {
            platform: 'win32',
            architecture: 'arm64',
            vscodeVersion: '1/2',
            extesterVersion: '8.23.0/alpha',
        });

        const tildeVersionDirectory = cache.getDownloadCacheEntryDirectory('/cache-root', {
            platform: 'win32',
            architecture: 'arm64',
            vscodeVersion: '1~2f~2',
            extesterVersion: '8.23.0/alpha',
        });

        assert.strictEqual(entryDirectory, path.join('/cache-root', 'v1', 'win32-arm64', 'vscode-1.122.1~2f~insiders', 'extester-8.23.0~2f~alpha'));
        assert.strictEqual(slashVersionDirectory, path.join('/cache-root', 'v1', 'win32-arm64', 'vscode-1~2f~2', 'extester-8.23.0~2f~alpha'));
        assert.strictEqual(tildeVersionDirectory, path.join('/cache-root', 'v1', 'win32-arm64', 'vscode-1~7e~2f~7e~2', 'extester-8.23.0~2f~alpha'));
        assert.notStrictEqual(slashVersionDirectory, tildeVersionDirectory);
    });

    test('keeps cache directories distinct after lowercasing uppercase VS Code versions', () => {
        const uppercaseVersionDirectory = cache.getDownloadCacheEntryDirectory('/cache-root', {
            platform: 'win32',
            architecture: 'arm64',
            vscodeVersion: '1.2.3-Beta',
            extesterVersion: '8.23.0/alpha',
        });

        const lowercaseVersionDirectory = cache.getDownloadCacheEntryDirectory('/cache-root', {
            platform: 'win32',
            architecture: 'arm64',
            vscodeVersion: '1.2.3-beta',
            extesterVersion: '8.23.0/alpha',
        });

        assert.notStrictEqual(uppercaseVersionDirectory.toLowerCase(), lowercaseVersionDirectory.toLowerCase());
        assert.ok(uppercaseVersionDirectory.includes('~42~eta'));
    });

    test('populates the cache once and reuses the immutable entry on subsequent calls', () => {
        const root = createTestRoot('cache-hit');
        const cacheRoot = path.join(root, 'cache');
        const expectedCacheDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        let populateCalls = 0;

        const firstResult = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    driverLayout: 'current',
                    includeArchives: true,
                });
            },
        }));

        const secondResult = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate() {
                populateCalls++;
                throw new Error('populate should not run on a cache hit');
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(firstResult.cacheHit, false);
        assert.strictEqual(secondResult.cacheHit, true);
        assert.strictEqual(firstResult.cacheDirectory, expectedCacheDirectory);
        assert.strictEqual(secondResult.cacheDirectory, expectedCacheDirectory);
        assert.deepStrictEqual(firstResult.manifest, secondResult.manifest);
        assert.deepStrictEqual(readManifest(expectedCacheDirectory), firstResult.manifest);
        assert.ok(fs.existsSync(path.join(expectedCacheDirectory, 'vscode-download.zip')));
        assert.ok(fs.existsSync(path.join(expectedCacheDirectory, 'chromedriver-download.tgz')));
    });

    test('allows racing processes to converge on one published cache entry', async function () {
        this.timeout(30_000);

        const root = createTestRoot('race');
        const cacheRoot = path.join(root, 'cache');
        const counterFile = path.join(root, 'populate-count.txt');
        const goPath = path.join(root, 'go.txt');
        const readyOne = path.join(root, 'ready-one.txt');
        const readyTwo = path.join(root, 'ready-two.txt');
        const workerScript = createRaceWorkerScript(root);

        const workerOne = spawnWorker(workerScript, {
            CACHE_ROOT: cacheRoot,
            COUNTER_FILE: counterFile,
            GO_PATH: goPath,
            READY_PATH: readyOne,
            POPULATE_DELAY_MS: '300',
        }, 15000);

        const workerTwo = spawnWorker(workerScript, {
            CACHE_ROOT: cacheRoot,
            COUNTER_FILE: counterFile,
            GO_PATH: goPath,
            READY_PATH: readyTwo,
            POPULATE_DELAY_MS: '300',
        }, 15000);

        await waitForPaths([readyOne, readyTwo], 10000);
        fs.writeFileSync(goPath, 'go');

        const results = await Promise.all([workerOne, workerTwo]);
        const populationCount = readPopulationCount(counterFile);
        const cacheHits = results.map((result) => result.cacheHit).sort((left, right) => Number(left) - Number(right));
        const publishedEntryDirectory = results[0].cacheDirectory;

        // Rename-wins may duplicate cold-start download work; the invariant is one durable winner.
        assert.strictEqual(populationCount >= 1 && populationCount <= 2, true);
        assert.deepStrictEqual(cacheHits, [false, true]);
        assert.deepStrictEqual(results.map((result) => result.cacheDirectory), [publishedEntryDirectory, publishedEntryDirectory]);
        assert.deepStrictEqual(results.map((result) => result.manifest), [results[0].manifest, results[0].manifest]);
        assert.deepStrictEqual(readManifest(publishedEntryDirectory), results[0].manifest);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(publishedEntryDirectory)).filter((entry) => entry === path.basename(publishedEntryDirectory)), [path.basename(publishedEntryDirectory)]);
        assertNoStagingSiblings(publishedEntryDirectory);
    });

    test('publish race loser adopts the winner', () => {
        const root = createTestRoot('publish-race-adopts-winner');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                const winnerStagingDirectory = fs.mkdtempSync(path.join(path.dirname(entryDirectory), `${path.basename(entryDirectory)}-staging-winner-`));
                publishValidCacheEntry(winnerStagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    vscodeVersion: '1.122.1',
                    extesterVersion: '8.23.0',
                    markerFileName: 'winner-marker.txt',
                });
                fs.renameSync(winnerStagingDirectory, entryDirectory);

                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
                writeFile(path.join(stagingDirectory, 'loser-marker.txt'), 'loser');
            },
        }));

        assert.strictEqual(result.cacheHit, true);
        assert.strictEqual(fs.readFileSync(path.join(result.cacheDirectory, 'winner-marker.txt'), 'utf8'), 'winner-marker.txt');
        assert.strictEqual(fs.existsSync(path.join(result.cacheDirectory, 'loser-marker.txt')), false);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
        assertNoStagingSiblings(entryDirectory);
    });

    test('publish race fails clearly when the winner is unusable', () => {
        const root = createTestRoot('publish-race-invalid-winner');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                const winnerStagingDirectory = fs.mkdtempSync(path.join(path.dirname(entryDirectory), `${path.basename(entryDirectory)}-staging-invalid-winner-`));
                populateFakeDownload(winnerStagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
                fs.renameSync(winnerStagingDirectory, entryDirectory);

                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        })), /published an unusable/);

        assertNoStagingSiblings(entryDirectory);
    });

    test('recovers from repeated population crashes without wedging the cache entry', () => {
        const root = createTestRoot('crash-resilience');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        let populateCalls = 0;

        const options = getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                writeFile(path.join(stagingDirectory, 'partial.txt'), 'partial');
                if (populateCalls <= 2) {
                    throw new Error(`synthetic populate crash ${populateCalls}`);
                }

                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        });

        assert.throws(() => cache.ensureDownloadCache(options), /synthetic populate crash 1/);
        assertNoStagingSiblings(entryDirectory);
        assert.throws(() => cache.ensureDownloadCache(options), /synthetic populate crash 2/);
        assertNoStagingSiblings(entryDirectory);

        const result = cache.ensureDownloadCache(options);

        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(populateCalls, 3);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
        assertNoStagingSiblings(entryDirectory);
    });

    test('rejects a deep non-manifest symlink that escapes the cache entry', () => {
        const root = createTestRoot('deep-escaping-symlink');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalTargetPath = path.join(root, 'external-target.txt');
        writeFile(externalTargetPath, 'external content');

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                const artifacts = populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
                const deepLinkPath = path.join(stagingDirectory, artifacts.vscodeDirectory, 'resources', 'app', 'out', 'escape.txt');
                ensureParentDirectory(deepLinkPath);
                fs.symlinkSync(externalTargetPath, deepLinkPath, 'file');
            },
        })), /escapes it/);

        assert.strictEqual(fs.readFileSync(externalTargetPath, 'utf8'), 'external content');
        assert.strictEqual(fs.existsSync(entryDirectory), false);
        assertNoStagingSiblings(entryDirectory);
    });

    test('rejects a deep non-manifest hard-linked file reachable from outside the cache entry', () => {
        const root = createTestRoot('deep-hard-link');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalTargetPath = path.join(root, 'external-hard-link-target.txt');
        writeFile(externalTargetPath, 'external content');

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                const artifacts = populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
                const deepLinkPath = path.join(stagingDirectory, artifacts.vscodeDirectory, 'resources', 'app', 'out', 'linked.txt');
                createHardFileLink(deepLinkPath, externalTargetPath);
            },
        })), /hard-linked file reachable from outside it/);

        assert.strictEqual(fs.readFileSync(externalTargetPath, 'utf8'), 'external content');
        assert.strictEqual(fs.existsSync(entryDirectory), false);
        assertNoStagingSiblings(entryDirectory);
    });

    test('accepts an internal deep symlink inside the cache entry', () => {
        const root = createTestRoot('deep-internal-symlink');
        const cacheRoot = path.join(root, 'cache');

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                const artifacts = populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
                const deepDirectory = path.join(stagingDirectory, artifacts.vscodeDirectory, 'resources', 'app', 'out');
                const targetPath = path.join(deepDirectory, 'target.txt');
                const linkPath = path.join(deepDirectory, 'alias.txt');
                writeFile(targetPath, 'internal content');
                fs.symlinkSync('target.txt', linkPath, 'file');
            },
        }));

        const linkPath = path.join(result.cacheDirectory, result.manifest.vscodeDirectory, 'resources', 'app', 'out', 'alias.txt');
        const targetPath = path.join(result.cacheDirectory, result.manifest.vscodeDirectory, 'resources', 'app', 'out', 'target.txt');

        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.realpathSync(linkPath), fs.realpathSync(targetPath));
        assert.strictEqual(fs.readFileSync(linkPath, 'utf8'), 'internal content');
        assertNoStagingSiblings(result.cacheDirectory);
    });

    test('removes stale staging siblings while preserving recent staging siblings', () => {
        const root = createTestRoot('stale-staging-sweep');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const staleStagingDirectory = path.join(path.dirname(entryDirectory), `${path.basename(entryDirectory)}-staging-old`);
        const recentStagingDirectory = path.join(path.dirname(entryDirectory), `${path.basename(entryDirectory)}-staging-recent`);

        fs.mkdirSync(staleStagingDirectory, { recursive: true });
        fs.mkdirSync(recentStagingDirectory, { recursive: true });
        setPathModifiedTime(staleStagingDirectory, new Date(Date.now() - 7 * 60 * 60 * 1000));

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.existsSync(staleStagingDirectory), false);
        assert.strictEqual(fs.existsSync(recentStagingDirectory), true);
        assert.deepStrictEqual(getStagingSiblingNames(entryDirectory), [path.basename(recentStagingDirectory)]);
    });

    test('discards unusable pre-existing entries and repopulates the cache', () => {
        const root = createTestRoot('discard-unusable-entry');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        let populateCalls = 0;

        fs.mkdirSync(entryDirectory, { recursive: true });
        writeFile(path.join(entryDirectory, 'old-marker.txt'), 'old corrupt entry');

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(fs.existsSync(path.join(result.cacheDirectory, 'old-marker.txt')), false);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
        assert.deepStrictEqual(getDiscardedSiblingNames(entryDirectory), []);
        assertNoStagingSiblings(entryDirectory);
    });

    test('cleans up staging directories when population fails', () => {
        const root = createTestRoot('populate-failure');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                writeFile(path.join(stagingDirectory, 'partial', 'file.txt'), 'partial');
                throw new Error('populate failed');
            },
        })), /populate failed/);

        assert.strictEqual(fs.existsSync(entryDirectory), false);
        assertNoStagingSiblings(entryDirectory);
    });

    test('rejects incomplete manifests and repopulates the cache entry', () => {
        const root = createTestRoot('corrupt-manifest');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        let populateCalls = 0;

        fs.mkdirSync(entryDirectory, { recursive: true });
        populateFakeDownload(entryDirectory, {
            platform: 'linux',
            architecture: 'x64',
        });
        writeFile(path.join(entryDirectory, 'old-marker.txt'), 'old entry');
        writeFile(path.join(entryDirectory, cache.CACHE_MANIFEST_NAME), JSON.stringify({
            schemaVersion: cache.CACHE_SCHEMA_VERSION,
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
            vscodeDirectory: 'VSCode-linux-x64',
            chromeDriverEntry: 'chromedriver-linux-x64',
        }, null, 2));

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    driverLayout: 'legacy',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.ok(!fs.existsSync(path.join(result.cacheDirectory, 'old-marker.txt')));
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
        assert.strictEqual(result.manifest.chromeDriverEntry, 'chromedriver');
        assert.strictEqual(result.manifest.chromeDriverBinary, 'chromedriver');
    });

    test('rejects linked cached artifacts and repopulates the cache entry', () => {
        const root = createTestRoot('linked-artifacts');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const escapedArtifactsRoot = path.join(root, 'escaped-artifacts');
        const escapedArtifacts = populateFakeDownload(escapedArtifactsRoot, {
            platform: 'linux',
            architecture: 'x64',
            driverLayout: 'current',
        });
        let populateCalls = 0;

        fs.mkdirSync(entryDirectory, { recursive: true });
        createDirectoryLink(path.join(entryDirectory, escapedArtifacts.vscodeDirectory), path.join(escapedArtifactsRoot, escapedArtifacts.vscodeDirectory));
        createDirectoryLink(path.join(entryDirectory, escapedArtifacts.chromeDriverEntry), path.join(escapedArtifactsRoot, escapedArtifacts.chromeDriverEntry));
        writeFile(path.join(entryDirectory, cache.CACHE_MANIFEST_NAME), JSON.stringify({
            schemaVersion: cache.CACHE_SCHEMA_VERSION,
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
            vscodeDirectory: escapedArtifacts.vscodeDirectory,
            chromeDriverEntry: escapedArtifacts.chromeDriverEntry,
            chromeDriverBinary: escapedArtifacts.chromeDriverBinary,
        }, null, 2));

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    driverLayout: 'current',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.lstatSync(path.join(result.cacheDirectory, result.manifest.vscodeDirectory)).isSymbolicLink(), false);
        assert.strictEqual(fs.lstatSync(path.join(result.cacheDirectory, result.manifest.chromeDriverEntry)).isSymbolicLink(), false);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
    });

    test('rejects cache-entry directory symlinks on cache hits and replaces only the local link', () => {
        const root = createTestRoot('linked-cache-entry');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalEntry = path.join(root, 'external-cache-entry');
        const externalArtifacts = populateFakeDownload(externalEntry, {
            platform: 'linux',
            architecture: 'x64',
        });
        const externalSentinelPath = path.join(externalEntry, 'external-sentinel.txt');
        let populateCalls = 0;

        writeFile(path.join(externalEntry, cache.CACHE_MANIFEST_NAME), JSON.stringify({
            schemaVersion: cache.CACHE_SCHEMA_VERSION,
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
            vscodeDirectory: externalArtifacts.vscodeDirectory,
            chromeDriverEntry: externalArtifacts.chromeDriverEntry,
            chromeDriverBinary: externalArtifacts.chromeDriverBinary,
        }, null, 2));
        writeFile(externalSentinelPath, 'leave external entry alone');
        createDirectoryLink(entryDirectory, externalEntry);

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.lstatSync(entryDirectory).isSymbolicLink(), false);
        assert.strictEqual(fs.readFileSync(externalSentinelPath, 'utf8'), 'leave external entry alone');
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
    });

    test('rejects symlinked intermediate cache-entry parents before population and keeps external data untouched', () => {
        const root = createTestRoot('linked-entry-parent');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const linkedPlatformParent = path.join(cacheRoot, 'v1', 'linux-x64');
        const externalPlatformParent = path.join(root, 'external-platform-parent');
        const externalSentinelPath = path.join(externalPlatformParent, 'external-sentinel.txt');
        let populateCalls = 0;

        fs.mkdirSync(externalPlatformParent, { recursive: true });
        writeFile(externalSentinelPath, 'leave platform parent alone');
        createDirectoryLink(linkedPlatformParent, externalPlatformParent);

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        })), /Cache entry path component 'v1[\/]linux-x64' is a symbolic link or junction/i);

        assert.strictEqual(populateCalls, 0);
        assert.strictEqual(fs.lstatSync(linkedPlatformParent).isSymbolicLink(), true);
        assert.strictEqual(fs.readFileSync(externalSentinelPath, 'utf8'), 'leave platform parent alone');
        assert.strictEqual(fs.existsSync(path.join(externalPlatformParent, 'vscode-1.122.1')), false);
        assertNoStagingSiblings(entryDirectory);
    });

    test('rejects linked cache manifests on cache hits and keeps external sentinel content untouched', () => {
        const root = createTestRoot('linked-cache-manifest');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalManifestPath = path.join(root, process.platform === 'win32' ? 'external-manifest-hardlink.json' : 'external-manifest-symlink-target.json');
        const sentinelContent = JSON.stringify({
            schemaVersion: cache.CACHE_SCHEMA_VERSION,
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
            vscodeDirectory: 'VSCode-linux-x64',
            chromeDriverEntry: 'chromedriver-linux-x64',
            chromeDriverBinary: path.join('chromedriver-linux-x64', 'chromedriver'),
        }, null, 2);
        let populateCalls = 0;

        fs.mkdirSync(entryDirectory, { recursive: true });
        populateFakeDownload(entryDirectory, {
            platform: 'linux',
            architecture: 'x64',
        });
        writeFile(externalManifestPath, sentinelContent);
        createFileLink(path.join(entryDirectory, cache.CACHE_MANIFEST_NAME), externalManifestPath);

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.readFileSync(externalManifestPath, 'utf8'), sentinelContent);
        assert.strictEqual(fs.lstatSync(path.join(result.cacheDirectory, cache.CACHE_MANIFEST_NAME)).isSymbolicLink(), false);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
    });

    test('rejects hard-linked VS Code executables on cache hits and keeps the external sentinel content untouched', () => {
        const root = createTestRoot('hard-linked-vscode-executable');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalExecutablePath = path.join(root, 'external-vscode-executable');
        const vscodeExecutableRelativePath = getVsCodeExecutableRelativePath('linux', 'x64');
        const vscodeExecutablePath = path.join(entryDirectory, vscodeExecutableRelativePath);
        let populateCalls = 0;

        publishValidCacheEntry(entryDirectory, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        writeFile(externalExecutablePath, 'leave external vscode executable alone');
        fs.rmSync(vscodeExecutablePath);
        createHardFileLink(vscodeExecutablePath, externalExecutablePath);

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.readFileSync(externalExecutablePath, 'utf8'), 'leave external vscode executable alone');
        assert.strictEqual(fs.lstatSync(path.join(result.cacheDirectory, vscodeExecutableRelativePath)).nlink, 1);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
    });

    test('rejects hard-linked ChromeDriver binaries on cache hits and keeps the external sentinel content untouched', () => {
        const root = createTestRoot('hard-linked-chromedriver');
        const cacheRoot = path.join(root, 'cache');
        const entryDirectory = cache.getDownloadCacheEntryDirectory(cacheRoot, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        const externalChromeDriverPath = path.join(root, 'external-chromedriver');
        const chromeDriverBinaryPath = path.join(entryDirectory, 'chromedriver-linux-x64', 'chromedriver');
        let populateCalls = 0;

        publishValidCacheEntry(entryDirectory, {
            platform: 'linux',
            architecture: 'x64',
            vscodeVersion: '1.122.1',
            extesterVersion: '8.23.0',
        });
        writeFile(externalChromeDriverPath, 'leave external chromedriver alone');
        fs.rmSync(chromeDriverBinaryPath);
        createHardFileLink(chromeDriverBinaryPath, externalChromeDriverPath);

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(cacheRoot, {
            populate(stagingDirectory) {
                populateCalls++;
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                });
            },
        }));

        assert.strictEqual(populateCalls, 1);
        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(fs.readFileSync(externalChromeDriverPath, 'utf8'), 'leave external chromedriver alone');
        assert.strictEqual(fs.lstatSync(path.join(result.cacheDirectory, 'chromedriver-linux-x64', 'chromedriver')).nlink, 1);
        assert.deepStrictEqual(readManifest(result.cacheDirectory), result.manifest);
    });

    test('supports legacy and current chromedriver layouts and rejects multiple current driver directories', () => {
        const currentRoot = createTestRoot('current-layout');
        const currentResult = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(currentRoot, 'cache'), {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    driverLayout: 'current',
                });
            },
        }));

        assert.strictEqual(currentResult.manifest.chromeDriverEntry, 'chromedriver-linux-x64');
        assert.strictEqual(currentResult.manifest.chromeDriverBinary, path.join('chromedriver-linux-x64', 'chromedriver'));

        const legacyRoot = createTestRoot('legacy-layout');
        const legacyResult = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(legacyRoot, 'cache'), {
            platform: 'win32',
            architecture: 'x64',
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, {
                    platform: 'win32',
                    architecture: 'x64',
                    driverLayout: 'legacy',
                });
            },
        }));

        assert.strictEqual(legacyResult.manifest.vscodeDirectory, 'VSCode-win32-x64-archive');
        assert.strictEqual(legacyResult.manifest.chromeDriverEntry, 'chromedriver.exe');
        assert.strictEqual(legacyResult.manifest.chromeDriverBinary, 'chromedriver.exe');

        const invalidRoot = createTestRoot('multiple-driver-directories');
        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(path.join(invalidRoot, 'cache'), {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, {
                    platform: 'linux',
                    architecture: 'x64',
                    driverLayout: 'current',
                    extraCurrentDriverDirectories: ['chromedriver-linux-arm64'],
                });
            },
        })), /multiple top-level ChromeDriver directories/i);
    });

    test('fails clearly for unsupported VS Code platform and architecture combinations', () => {
        const root = createTestRoot('unsupported-platform');
        let populateCalled = false;

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            platform: 'win32',
            architecture: 'ia32',
            populate() {
                populateCalled = true;
            },
        })), /Unsupported VS Code platform\/architecture combination: win32\/ia32/i);
        assert.strictEqual(populateCalled, false);
    });

    test('projects only immutable assets into per-run storage', () => {
        const root = createTestRoot('projects-immutable-assets');
        const result = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, { platform: 'linux', architecture: 'x64' });
            },
        }));
        const storageDirectory = path.join(root, 'run-storage');

        cache.projectDownloadCache(result, storageDirectory);
        writeFile(path.join(storageDirectory, 'settings', 'User', 'settings.json'), '{}');
        writeFile(path.join(storageDirectory, 'screenshots', 'failure.png'), 'screenshot');

        assert.strictEqual(
            fs.realpathSync(path.join(storageDirectory, result.manifest.vscodeDirectory)),
            fs.realpathSync(path.join(result.cacheDirectory, result.manifest.vscodeDirectory)));
        assert.strictEqual(
            fs.realpathSync(path.join(storageDirectory, result.manifest.chromeDriverEntry)),
            fs.realpathSync(path.join(result.cacheDirectory, result.manifest.chromeDriverEntry)));
        assert.ok(fs.existsSync(path.join(storageDirectory, 'settings', 'User', 'settings.json')));
        assert.ok(!fs.existsSync(path.join(result.cacheDirectory, 'settings')));
        assert.ok(!fs.existsSync(path.join(result.cacheDirectory, 'screenshots')));
        assert.ok(!fs.existsSync(path.join(storageDirectory, cache.CACHE_MANIFEST_NAME)));
    });

    test('replaces stale projected entries so a reused storage directory tracks the cache', () => {
        const root = createTestRoot('replaces-stale-projection');
        const result = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, { platform: 'linux', architecture: 'x64' });
            },
        }));
        const storageDirectory = path.join(root, 'reused-storage');
        writeFile(path.join(storageDirectory, result.manifest.vscodeDirectory, 'stale.txt'), 'stale');

        cache.projectDownloadCache(result, storageDirectory);

        assert.strictEqual(
            fs.realpathSync(path.join(storageDirectory, result.manifest.vscodeDirectory)),
            fs.realpathSync(path.join(result.cacheDirectory, result.manifest.vscodeDirectory)));
        assert.ok(!fs.existsSync(path.join(result.cacheDirectory, result.manifest.vscodeDirectory, 'stale.txt')));
    });

    test('copies a legacy root-level ChromeDriver without sharing the mutable file', () => {
        const root = createTestRoot('legacy-driver-projection');
        const result = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            populate(stagingDirectory) {
                populateFakeDownload(stagingDirectory, { platform: 'linux', architecture: 'x64', driverLayout: 'legacy' });
            },
        }));
        const storageDirectory = path.join(root, 'legacy-run-storage');

        cache.projectDownloadCache(result, storageDirectory);
        const projectedDriver = path.join(storageDirectory, result.manifest.chromeDriverEntry);
        fs.writeFileSync(projectedDriver, 'run-local driver');

        assert.strictEqual(fs.lstatSync(projectedDriver).isSymbolicLink(), false);
        assert.strictEqual(
            fs.readFileSync(path.join(result.cacheDirectory, result.manifest.chromeDriverEntry), 'utf8'),
            'legacy chromedriver');
        assert.strictEqual(fs.readFileSync(projectedDriver, 'utf8'), 'run-local driver');
    });

    test('accepts the internal Electron symlink that ExTester creates in real macOS bundles', () => {
        const root = createTestRoot('darwin-internal-electron-symlink');
        const bundle = 'Visual Studio Code.app';

        const result = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            platform: 'darwin',
            architecture: 'arm64',
            populate(stagingDirectory) {
                // Mirror the real downloaded layout: ExTester unpacks the bundle with the actual
                // Mach-O binary named `Code` and then links `Electron -> Code` beside it.
                writeFile(path.join(stagingDirectory, bundle, 'Contents', 'MacOS', 'Code'), 'real vscode binary');
                fs.symlinkSync('Code', path.join(stagingDirectory, bundle, 'Contents', 'MacOS', 'Electron'));
                writeFile(path.join(stagingDirectory, 'chromedriver-darwin-arm64', 'chromedriver'), 'driver');
            },
        }));

        assert.strictEqual(result.cacheHit, false);
        assert.strictEqual(result.manifest.vscodeDirectory, bundle);
        assert.strictEqual(
            fs.readFileSync(path.join(result.cacheDirectory, bundle, 'Contents', 'MacOS', 'Electron'), 'utf8'),
            'real vscode binary');

        const reused = cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            platform: 'darwin',
            architecture: 'arm64',
            populate() {
                throw new Error('populate must not run when the cached bundle is valid.');
            },
        }));

        assert.strictEqual(reused.cacheHit, true);
    });

    test('rejects a VS Code executable symlink that escapes the cache entry', () => {
        const root = createTestRoot('darwin-escaping-electron-symlink');
        const outsideBinary = path.join(root, 'outside-binary');
        writeFile(outsideBinary, 'attacker binary');

        assert.throws(() => cache.ensureDownloadCache(getDefaultCacheOptions(path.join(root, 'cache'), {
            platform: 'darwin',
            architecture: 'arm64',
            populate(stagingDirectory) {
                const macOsDirectory = path.join(stagingDirectory, 'Visual Studio Code.app', 'Contents', 'MacOS');
                fs.mkdirSync(macOsDirectory, { recursive: true });
                fs.symlinkSync(outsideBinary, path.join(macOsDirectory, 'Electron'));
                writeFile(path.join(stagingDirectory, 'chromedriver-darwin-arm64', 'chromedriver'), 'driver');
            },
        })), /vscodeExecutable points to a symbolic link or junction that escapes the cache entry/i);

        assert.strictEqual(fs.readFileSync(outsideBinary, 'utf8'), 'attacker binary');
    });
});

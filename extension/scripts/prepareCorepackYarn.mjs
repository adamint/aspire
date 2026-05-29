#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const DefaultNpmRegistry = 'https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/';
const PackageManagerPattern = /^yarn@(?<version>\d+\.\d+\.\d+)$/;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = dirname(scriptDirectory);
const packageJsonPath = join(extensionDirectory, 'package.json');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const packageManager = packageJson.packageManager;
const match = typeof packageManager === 'string' ? PackageManagerPattern.exec(packageManager) : null;

if (match?.groups?.version === undefined) {
  fail(`Expected packageManager in ${packageJsonPath} to be an exact Yarn Classic version like "yarn@1.22.22", but found ${JSON.stringify(packageManager)}.`);
}

const yarnVersion = match.groups.version;
const majorVersion = Number(yarnVersion.split('.')[0]);

if (majorVersion >= 2) {
  fail(`The Corepack cache seeding workaround only supports Yarn Classic (<2.0.0), but packageManager is ${packageManager}. Remove this workaround and use Corepack's native prepare/install flow for Yarn Berry.`);
}

const registry = process.env.NPM_REGISTRY || DefaultNpmRegistry;
const corepackHome = getCorepackHome();
const installDirectory = join(corepackHome, 'v1', 'yarn', yarnVersion);
const installParentDirectory = dirname(installDirectory);
const corepackMetadataPath = join(installDirectory, '.corepack');

if (existsSync(corepackMetadataPath)) {
  console.log(`Corepack cache already contains yarn@${yarnVersion} at ${installDirectory}`);
  process.exit(0);
}

rmSync(installDirectory, { recursive: true, force: true });

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aspire-corepack-yarn-'));
mkdirSync(installParentDirectory, { recursive: true });
const stagingDirectory = mkdtempSync(join(installParentDirectory, `.yarn-${yarnVersion}-`));
let cacheSeeded = false;

try {
  console.log(`Packing yarn@${yarnVersion} from ${registry}`);
  const packResult = run(getNpmCommand(), ['pack', '--json', '--registry', registry, `yarn@${yarnVersion}`], temporaryDirectory);
  const packEntries = parseNpmPackJson(packResult.stdout);
  const packEntry = packEntries[0];

  if (packEntry === undefined || typeof packEntry.filename !== 'string' || typeof packEntry.shasum !== 'string') {
    fail(`npm pack did not return the expected filename and shasum metadata. Output: ${packResult.stdout}`);
  }

  const tarballPath = join(temporaryDirectory, packEntry.filename);

  // Corepack can use COREPACK_NPM_REGISTRY for npmjs.org, but Azure Artifacts
  // does not implement the /<package>/<version> metadata route Corepack calls.
  // Seed the same cache shape Corepack writes, using npm pack because npm can
  // resolve Yarn through the Azure Artifacts pull-through feed.
  run('tar', ['-xzf', tarballPath, '-C', stagingDirectory, '--strip-components=1'], temporaryDirectory);

  writeFileSync(corepackMetadataPathFor(stagingDirectory), JSON.stringify({
    locator: {
      name: 'yarn',
      reference: yarnVersion
    },
    bin: {
      yarn: './bin/yarn.js',
      yarnpkg: './bin/yarn.js'
    },
    hash: `sha1.${packEntry.shasum}`
  }));

  try {
    renameSync(stagingDirectory, installDirectory);
    cacheSeeded = true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      console.log(`Corepack cache already contains yarn@${yarnVersion} at ${installDirectory}`);
    } else {
      throw error;
    }
  }

  if (cacheSeeded) {
    console.log(`Seeded Corepack cache with yarn@${yarnVersion} at ${installDirectory}`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
  rmSync(stagingDirectory, { recursive: true, force: true });
}

function getCorepackHome() {
  if (process.env.COREPACK_HOME) {
    return process.env.COREPACK_HOME;
  }

  const baseDirectory = process.env.XDG_CACHE_HOME
    ?? process.env.LOCALAPPDATA
    ?? join(homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache');

  return join(baseDirectory, 'node', 'corepack');
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function corepackMetadataPathFor(directory) {
  return join(directory, '.corepack');
}

function parseNpmPackJson(stdout) {
  const jsonStart = stdout.indexOf('[');

  if (jsonStart === -1) {
    fail(`npm pack did not emit JSON output. Output: ${stdout}`);
  }

  return JSON.parse(stdout.slice(jsonStart));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    if (result.stdout) {
      process.stderr.write(result.stdout);
    }

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    const errorDetails = result.error ? ` (${result.error.message})` : '';
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${errorDetails}.`);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

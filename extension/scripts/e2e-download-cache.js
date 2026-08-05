'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_SCHEMA_VERSION = 1;
const CACHE_MANIFEST_NAME = 'cache-manifest.json';
const STAGING_DIRECTORY_INFIX = '-staging-';

// Staging directories only exist while a populate is in flight. A crashed run leaves one
// behind, so sweep siblings that are clearly older than any plausible in-flight download.
const STALE_STAGING_DIRECTORY_AGE_MS = 6 * 60 * 60 * 1000;

const GIT_REPOSITORY_LOCATION_ENVIRONMENT_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

function resolveDownloadCacheRoot(repoRoot, environment = process.env) {
  const configuredCacheRoot = environment.ASPIRE_EXTENSION_E2E_CACHE_ROOT;
  if (configuredCacheRoot) {
    return path.resolve(configuredCacheRoot);
  }

  const gitCommonDir = resolveGitCommonDir(repoRoot, spawnSync, environment);
  return path.join(gitCommonDir, 'aspire-extension-e2e-cache');
}

function getDownloadCacheEntryDirectory(cacheRoot, { platform, architecture, vscodeVersion, extesterVersion }) {
  return path.join(
    cacheRoot,
    `v${CACHE_SCHEMA_VERSION}`,
    `${encodePathSegment(platform)}-${encodePathSegment(architecture)}`,
    `vscode-${encodePathSegment(vscodeVersion)}`,
    `extester-${encodePathSegment(extesterVersion)}`
  );
}

/**
 * Returns the shared cache entry holding the VS Code and ChromeDriver downloads, populating it
 * first when it is missing or unusable.
 *
 * Concurrency is handled by publishing with `fs.renameSync`, which cannot overwrite a non-empty
 * directory: every run populates its own staging directory, and the first run to rename wins.
 * Runs that lose the race discard their staging copy and reuse the winner's entry. That costs a
 * duplicate download in the rare case where several runs cold-start at once, which is far cheaper
 * than a lock protocol whose failure modes (abandoned locks, half-released generations) can wedge
 * every later run until a human deletes the cache by hand.
 */
function ensureDownloadCache(options) {
  const normalizedOptions = normalizeEnsureDownloadCacheOptions(options);
  const expectedManifest = getExpectedManifestIdentity(normalizedOptions);
  const cacheDirectory = getDownloadCacheEntryDirectory(normalizedOptions.cacheRoot, expectedManifest);
  const entryParentDirectory = path.dirname(cacheDirectory);

  const existingManifest = tryReadCacheManifest(cacheDirectory, expectedManifest, {
    cacheRoot: normalizedOptions.cacheRoot,
    warnOnInvalid: true,
  });
  if (existingManifest) {
    return { cacheHit: true, cacheDirectory, manifest: existingManifest };
  }

  // A directory that exists but failed validation is unusable. Move it aside before renaming a
  // fresh entry into place, because rename cannot replace a non-empty directory.
  discardUnusableCacheEntry(cacheDirectory);

  // Verify the ancestor chain before creating anything: a symlinked parent would otherwise make
  // populate() download into, and publish through, a directory outside the cache root.
  assertTrustedEntryAncestry(normalizedOptions.cacheRoot, cacheDirectory);

  fs.mkdirSync(entryParentDirectory, { recursive: true });
  sweepStaleStagingDirectories(entryParentDirectory, path.basename(cacheDirectory));

  const stagingDirectory = fs.mkdtempSync(path.join(entryParentDirectory, `${path.basename(cacheDirectory)}${STAGING_DIRECTORY_INFIX}`));

  let published = false;
  try {
    normalizedOptions.populate(stagingDirectory);

    const artifacts = discoverCacheArtifacts(stagingDirectory, normalizedOptions.platform, normalizedOptions.architecture);
    writeCacheManifest(stagingDirectory, { ...expectedManifest, ...artifacts });
    assertCacheEntryTreeIsContained(stagingDirectory);

    published = tryPublishStagingDirectory(stagingDirectory, cacheDirectory);
  } finally {
    if (!published) {
      removeDirectoryBestEffort(stagingDirectory);
    }
  }

  if (!published) {
    // Another run published first. Its entry is equivalent, so adopt it rather than retrying.
    const winningManifest = tryReadCacheManifest(cacheDirectory, expectedManifest, {
      cacheRoot: normalizedOptions.cacheRoot,
      warnOnInvalid: true,
    });
    if (winningManifest) {
      return { cacheHit: true, cacheDirectory, manifest: winningManifest };
    }

    throw new Error(`Another process published an unusable E2E download cache entry at '${cacheDirectory}'. Delete it and re-run.`);
  }

  const manifest = readCacheManifest(cacheDirectory, expectedManifest, { cacheRoot: normalizedOptions.cacheRoot });
  return { cacheHit: false, cacheDirectory, manifest };
}

function tryPublishStagingDirectory(stagingDirectory, cacheDirectory) {
  try {
    fs.renameSync(stagingDirectory, cacheDirectory);
    return true;
  } catch (error) {
    // rename onto an existing non-empty directory fails (ENOTEMPTY on POSIX, EEXIST/EPERM on
    // Windows), which is exactly how a concurrent publish is detected.
    if (isPublishRaceError(error)) {
      return false;
    }

    throw error;
  }
}

function discardUnusableCacheEntry(cacheDirectory) {
  if (!fs.existsSync(cacheDirectory)) {
    return;
  }

  // Rename out of the way first so a concurrent reader never observes a partially deleted entry.
  const discardedPath = `${cacheDirectory}.discarded-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(cacheDirectory, discardedPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  removeDirectoryBestEffort(discardedPath);
}

function sweepStaleStagingDirectories(entryParentDirectory, entryLeafName) {
  const stagingPrefix = `${entryLeafName}${STAGING_DIRECTORY_INFIX}`;
  const discardedPrefix = `${entryLeafName}.discarded-`;

  let entries;
  try {
    entries = fs.readdirSync(entryParentDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(stagingPrefix) && !entry.name.startsWith(discardedPrefix)) {
      continue;
    }

    const candidatePath = path.join(entryParentDirectory, entry.name);
    try {
      if (Date.now() - fs.lstatSync(candidatePath).mtimeMs < STALE_STAGING_DIRECTORY_AGE_MS) {
        continue;
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    removeDirectoryBestEffort(candidatePath);
  }
}

function removeDirectoryBestEffort(directoryPath) {
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    // Losing a staging or discarded directory is not fatal; the next sweep retries it.
    writeWarning(`Unable to remove '${directoryPath}': ${describeOperationError(error)}`);
  }
}

function normalizeEnsureDownloadCacheOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('ensureDownloadCache requires an options object.');
  }

  if (typeof options.cacheRoot !== 'string' || options.cacheRoot.length === 0) {
    throw new Error('ensureDownloadCache requires a non-empty cacheRoot.');
  }

  if (typeof options.vscodeVersion !== 'string' || options.vscodeVersion.length === 0) {
    throw new Error('ensureDownloadCache requires a non-empty vscodeVersion.');
  }

  if (typeof options.extesterVersion !== 'string' || options.extesterVersion.length === 0) {
    throw new Error('ensureDownloadCache requires a non-empty extesterVersion.');
  }

  if (typeof options.populate !== 'function') {
    throw new Error('ensureDownloadCache requires a synchronous populate(stagingDirectory) callback.');
  }

  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;

  // Validate the VS Code layout up front so unsupported combinations fail before
  // populate() starts an expensive download into a staging directory.
  getVsCodeDirectoryName(platform, architecture);
  getVsCodeExecutableRelativePath(platform, architecture);

  return {
    cacheRoot: path.resolve(options.cacheRoot),
    vscodeVersion: options.vscodeVersion,
    extesterVersion: options.extesterVersion,
    platform,
    architecture,
    populate: options.populate,
  };
}

function getExpectedManifestIdentity(options) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    platform: options.platform,
    architecture: options.architecture,
    vscodeVersion: options.vscodeVersion,
    extesterVersion: options.extesterVersion,
  };
}

function writeCacheManifest(cacheDirectory, manifest) {
  fs.writeFileSync(path.join(cacheDirectory, CACHE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function tryReadCacheManifest(cacheDirectory, expectedManifest, { cacheRoot, warnOnInvalid }) {
  try {
    if (!fs.existsSync(path.join(cacheDirectory, CACHE_MANIFEST_NAME))) {
      return null;
    }

    return readCacheManifest(cacheDirectory, expectedManifest, { cacheRoot });
  } catch (error) {
    if (warnOnInvalid) {
      writeWarning(`Ignoring invalid E2E download cache entry '${cacheDirectory}': ${error.message} The cache will be repopulated.`);
    }

    return null;
  }
}

function readCacheManifest(cacheDirectory, expectedManifest, { cacheRoot }) {
  const realCacheDirectory = assertTrustedCacheEntryDirectory(cacheDirectory, cacheRoot);

  const manifestPath = path.join(cacheDirectory, CACHE_MANIFEST_NAME);
  assertOrdinaryFileWithSingleLink(manifestPath, CACHE_MANIFEST_NAME);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${CACHE_MANIFEST_NAME}: ${error.message}`);
  }

  validateManifestIdentity(manifest, expectedManifest);

  const manifestPaths = {
    vscodeDirectory: normalizeManifestRelativePath(manifest.vscodeDirectory, 'vscodeDirectory'),
    chromeDriverEntry: normalizeManifestRelativePath(manifest.chromeDriverEntry, 'chromeDriverEntry'),
    chromeDriverBinary: normalizeManifestRelativePath(manifest.chromeDriverBinary, 'chromeDriverBinary'),
  };

  assertOrdinaryRelativePath(cacheDirectory, realCacheDirectory, manifestPaths.vscodeDirectory, 'vscodeDirectory', 'directory');
  assertOrdinaryRelativePath(cacheDirectory, realCacheDirectory, manifestPaths.chromeDriverEntry, 'chromeDriverEntry', 'directory-or-file');
  assertOrdinaryRelativePath(cacheDirectory, realCacheDirectory, manifestPaths.chromeDriverBinary, 'chromeDriverBinary', 'file');

  const discoveredArtifacts = discoverCacheArtifacts(cacheDirectory, expectedManifest.platform, expectedManifest.architecture, realCacheDirectory);
  for (const [field, expectedValue] of Object.entries(discoveredArtifacts)) {
    if (manifestPaths[field] !== expectedValue) {
      throw new Error(`${field} must be '${expectedValue}' for ${expectedManifest.platform}/${expectedManifest.architecture}, but found '${manifest[field]}'.`);
    }
  }

  // The projected tree is executed by VS Code, so every entry in it -- not just the paths named
  // by the manifest -- has to stay inside the cache entry.
  assertCacheEntryTreeIsContained(cacheDirectory, realCacheDirectory);

  return {
    ...expectedManifest,
    ...manifestPaths,
  };
}

/**
 * Walks the whole cache entry and rejects any symlink whose target escapes it, plus any regular
 * file reachable through more than one directory entry.
 *
 * Validating only the manifest paths would leave the rest of the projected tree unchecked, and
 * VS Code loads far more than the executable named in the manifest.
 *
 * Genuine artifacts contain internal symlinks -- a macOS VS Code bundle has framework links such
 * as `Contents/Frameworks/Electron Framework.framework/Versions/Current`, plus the
 * `Contents/MacOS/Electron -> Code` link ExTester creates while unpacking -- so links are allowed
 * as long as they resolve inside the entry. Real bundles contain no hard-linked files, so a link
 * count above one means the content is also reachable (and mutable) from outside the cache.
 */
function assertCacheEntryTreeIsContained(cacheDirectory, realCacheDirectory = resolveRealPath(cacheDirectory)) {
  const pendingDirectories = [cacheDirectory];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();

    let entries;
    try {
      entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        let linkTargetRealPath;
        try {
          linkTargetRealPath = resolveRealPath(entryPath);
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            throw new Error(`Cache entry contains a broken symbolic link at '${path.relative(cacheDirectory, entryPath)}'.`);
          }

          throw error;
        }

        if (!isPathContainedWithin(realCacheDirectory, linkTargetRealPath)) {
          throw new Error(`Cache entry contains a symbolic link that escapes it at '${path.relative(cacheDirectory, entryPath)}'.`);
        }

        // Do not descend through the link: its target lives inside the entry and is walked
        // directly, and following links here could revisit directories indefinitely.
        continue;
      }

      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      let entryStats;
      try {
        entryStats = fs.lstatSync(entryPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      if (entryStats.nlink !== 1) {
        throw new Error(`Cache entry contains a hard-linked file reachable from outside it at '${path.relative(cacheDirectory, entryPath)}' (link count ${entryStats.nlink}).`);
      }
    }
  }
}

/**
 * Rejects a cache entry whose existing ancestors are not ordinary directories inside the cache
 * root. Missing ancestors are fine; they are created during population.
 */
function assertTrustedEntryAncestry(cacheRoot, cacheDirectory) {
  const realCacheRoot = resolveTrustBoundaryRootDirectory(cacheRoot);
  const relativeEntryPath = path.relative(cacheRoot, cacheDirectory);
  if (relativeEntryPath.length === 0 || relativeEntryPath.startsWith('..') || path.isAbsolute(relativeEntryPath)) {
    throw new Error(`Cache entry '${cacheDirectory}' must be contained within '${cacheRoot}'.`);
  }

  let candidatePath = cacheRoot;
  const segments = relativeEntryPath.split(path.sep).filter(segment => segment.length > 0);
  for (let index = 0; index < segments.length; index++) {
    candidatePath = path.join(candidatePath, segments[index]);
    const relativeCandidatePath = path.join(...segments.slice(0, index + 1));

    let candidateStats;
    try {
      candidateStats = fs.lstatSync(candidatePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // Nothing below a missing component can exist yet, so the rest of the chain is clean.
        return;
      }

      throw error;
    }

    if (candidateStats.isSymbolicLink()) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' is a symbolic link or junction.`);
    }

    if (!candidateStats.isDirectory()) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' must be a directory.`);
    }

    if (!isPathContainedWithin(realCacheRoot, resolveRealPath(candidatePath))) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' resolves outside '${realCacheRoot}'.`);
    }
  }
}

function assertTrustedCacheEntryDirectory(cacheDirectory, trustBoundaryRootDirectory) {
  const realTrustBoundaryRootDirectory = resolveTrustBoundaryRootDirectory(trustBoundaryRootDirectory);
  const relativeEntryPath = path.relative(trustBoundaryRootDirectory, cacheDirectory);
  if (relativeEntryPath.length === 0 || relativeEntryPath.startsWith('..') || path.isAbsolute(relativeEntryPath)) {
    throw new Error(`Cache entry '${cacheDirectory}' must be contained within '${trustBoundaryRootDirectory}'.`);
  }

  let candidatePath = trustBoundaryRootDirectory;
  const segments = relativeEntryPath.split(path.sep).filter(segment => segment.length > 0);
  for (let index = 0; index < segments.length; index++) {
    candidatePath = path.join(candidatePath, segments[index]);
    const relativeCandidatePath = path.join(...segments.slice(0, index + 1));

    let candidateStats;
    try {
      candidateStats = fs.lstatSync(candidatePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`Cache entry path component '${relativeCandidatePath}' is missing.`);
      }

      throw error;
    }

    if (candidateStats.isSymbolicLink()) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' is a symbolic link or junction.`);
    }

    if (!candidateStats.isDirectory()) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' must be a directory.`);
    }

    const realCandidatePath = resolveRealPath(candidatePath);
    if (!isPathContainedWithin(realTrustBoundaryRootDirectory, realCandidatePath)) {
      throw new Error(`Cache entry path component '${relativeCandidatePath}' resolves outside '${realTrustBoundaryRootDirectory}'.`);
    }
  }

  return resolveRealPath(cacheDirectory);
}

function validateManifestIdentity(manifest, expectedManifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${CACHE_MANIFEST_NAME} must contain a JSON object.`);
  }

  for (const [field, expectedValue] of Object.entries(expectedManifest)) {
    if (manifest[field] !== expectedValue) {
      throw new Error(`${field} must be '${expectedValue}', but found '${manifest[field]}'.`);
    }
  }
}

function normalizeManifestRelativePath(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a relative path string.`);
  }

  if (value.length === 0 || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${fieldName} must be a non-empty relative path inside the cache entry.`);
  }

  const segments = value.split(/[\\/]+/);
  if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${fieldName} must not contain empty, '.' or '..' path segments.`);
  }

  return path.join(...segments);
}

function assertOrdinaryRelativePath(rootDirectory, realRootDirectory, relativePath, fieldName, expectedType) {
  let candidatePath = rootDirectory;
  const segments = relativePath.split(/[\\/]+/);

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    candidatePath = path.join(candidatePath, segment);

    let candidateStats;
    try {
      candidateStats = fs.lstatSync(candidatePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`${fieldName} points to a missing path '${relativePath}'.`);
      }

      throw error;
    }

    const candidateRelativePath = path.join(...segments.slice(0, index + 1));
    if (candidateStats.isSymbolicLink()) {
      // Genuine VS Code macOS bundles contain internal symlinks: ExTester creates
      // `Visual Studio Code.app/Contents/MacOS/Electron -> Code` while unpacking the archive
      // because its launcher resolves the executable as `Electron`. Rejecting every symlink
      // outright rejects the real artifact, so follow links that stay inside the cache entry
      // and reject only those that redirect outside it.
      let linkTargetRealPath;
      try {
        linkTargetRealPath = resolveRealPath(candidatePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error(`${fieldName} points to a broken symbolic link at '${candidateRelativePath}'.`);
        }

        throw error;
      }

      if (!isPathContainedWithin(realRootDirectory, linkTargetRealPath)) {
        throw new Error(`${fieldName} points to a symbolic link or junction that escapes the cache entry at '${candidateRelativePath}'.`);
      }

      // Re-stat through the link so the type checks below describe the target.
      candidateStats = fs.statSync(candidatePath);
    }

    const isFinalSegment = index === segments.length - 1;
    if (!isFinalSegment) {
      if (!candidateStats.isDirectory()) {
        throw new Error(`${fieldName} path component '${candidateRelativePath}' must be a directory.`);
      }

      continue;
    }

    if (expectedType === 'directory' && !candidateStats.isDirectory()) {
      throw new Error(`${fieldName} must point to a directory at '${relativePath}'.`);
    }

    if (expectedType === 'file' && !candidateStats.isFile()) {
      throw new Error(`${fieldName} must point to a file at '${relativePath}'.`);
    }

    if (expectedType === 'file' && candidateStats.nlink !== 1) {
      throw new Error(`${fieldName} must point to a single-link file at '${relativePath}', but found link count ${candidateStats.nlink}.`);
    }
  }

  const realCandidatePath = resolveRealPath(candidatePath);
  if (!isPathContainedWithin(realRootDirectory, realCandidatePath)) {
    throw new Error(`${fieldName} resolves outside the cache entry: '${relativePath}'.`);
  }
}

function resolveRealPath(candidatePath) {
  return (fs.realpathSync.native ?? fs.realpathSync)(candidatePath);
}

function resolveTrustBoundaryRootDirectory(rootDirectory) {
  return fs.existsSync(rootDirectory) ? resolveRealPath(rootDirectory) : path.resolve(rootDirectory);
}

function assertOrdinaryFileWithSingleLink(filePath, description) {
  let fileStats;
  try {
    fileStats = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`${description} is missing.`);
    }

    throw error;
  }

  if (fileStats.isSymbolicLink()) {
    throw new Error(`${description} must not be a symbolic link or junction.`);
  }

  if (!fileStats.isFile()) {
    throw new Error(`${description} must be a file.`);
  }

  if (fileStats.nlink !== 1) {
    throw new Error(`${description} must be a single-link file, but found link count ${fileStats.nlink}.`);
  }
}

function isPathContainedWithin(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function discoverCacheArtifacts(rootDirectory, platform, architecture, realRootDirectory = resolveRealPath(rootDirectory)) {
  const vscodeDirectory = getVsCodeDirectoryName(platform, architecture);
  const vscodeExecutableRelativePath = getVsCodeExecutableRelativePath(platform, architecture);
  const chromeDriverBinaryName = getChromeDriverBinaryName(platform);

  assertOrdinaryRelativePath(rootDirectory, realRootDirectory, vscodeDirectory, 'vscodeDirectory', 'directory');
  assertOrdinaryRelativePath(rootDirectory, realRootDirectory, vscodeExecutableRelativePath, 'vscodeExecutable', 'file');

  const legacyChromeDriverPath = path.join(rootDirectory, chromeDriverBinaryName);
  if (isFile(legacyChromeDriverPath)) {
    assertOrdinaryRelativePath(rootDirectory, realRootDirectory, chromeDriverBinaryName, 'chromeDriverBinary', 'file');

    return {
      vscodeDirectory,
      chromeDriverEntry: chromeDriverBinaryName,
      chromeDriverBinary: chromeDriverBinaryName,
    };
  }

  const chromeDriverEntries = fs.readdirSync(rootDirectory, { withFileTypes: true })
    .filter(entry => entry.name.startsWith('chromedriver-') && (entry.isDirectory() || entry.isSymbolicLink()));

  if (chromeDriverEntries.length === 0) {
    throw new Error(`Expected either a top-level '${chromeDriverBinaryName}' binary or exactly one 'chromedriver-*' directory under '${rootDirectory}'.`);
  }

  if (chromeDriverEntries.length > 1) {
    throw new Error(`Found multiple top-level ChromeDriver directories under '${rootDirectory}': ${chromeDriverEntries.map(entry => entry.name).join(', ')}.`);
  }

  const chromeDriverEntry = chromeDriverEntries[0].name;
  const chromeDriverBinary = path.join(chromeDriverEntry, chromeDriverBinaryName);
  assertOrdinaryRelativePath(rootDirectory, realRootDirectory, chromeDriverEntry, 'chromeDriverEntry', 'directory');
  assertOrdinaryRelativePath(rootDirectory, realRootDirectory, chromeDriverBinary, 'chromeDriverBinary', 'file');

  return {
    vscodeDirectory,
    chromeDriverEntry,
    chromeDriverBinary,
  };
}

function getVsCodeDirectoryName(platform, architecture) {
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

function getVsCodeExecutableRelativePath(platform, architecture) {
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

function getChromeDriverBinaryName(platform) {
  return platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
}

function describeOperationError(error) {
  if (!error) {
    return 'Unknown error';
  }

  return error.code ? `${error.code}: ${error.message}` : error.message;
}

function writeWarning(message) {
  process.stderr.write(`${message}\n`);
}

function isPublishRaceError(error) {
  return error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTDIR');
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function resolveGitCommonDir(repoRoot, gitRunner = spawnSync, environment = process.env, platform = process.platform) {
  const gitEnvironment = mergeEnvironment(process.env, environment, platform);

  // Strip repository-discovery variables so `git -C` resolves against the
  // requested repo root instead of inheriting an unrelated shell repository.
  for (const key of Object.keys(gitEnvironment)) {
    if (!GIT_REPOSITORY_LOCATION_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      continue;
    }

    delete gitEnvironment[key];
  }

  const result = gitRunner('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', shell: false, env: gitEnvironment });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`Unable to resolve the E2E download cache root from git for '${repoRoot}': ${describeGitResult(result)} Set ASPIRE_EXTENSION_E2E_CACHE_ROOT to an absolute path.`);
  }

  const gitCommonDir = result.stdout.trim();
  if (!gitCommonDir) {
    throw new Error(`Git returned an empty common dir for '${repoRoot}': ${describeGitResult(result)} Set ASPIRE_EXTENSION_E2E_CACHE_ROOT to an absolute path.`);
  }

  return gitCommonDir;
}

function mergeEnvironment(baseEnvironment, overrideEnvironment, platform = process.platform) {
  const mergedEnvironment = {};

  if (platform === 'win32') {
    // Windows treats environment names case-insensitively, so keep only one
    // entry per logical key and let the caller's casing/value win.
    const keysByLowerCase = new Map();

    for (const [key, value] of Object.entries(baseEnvironment)) {
      if (value === undefined) {
        continue;
      }

      mergedEnvironment[key] = value;
      keysByLowerCase.set(key.toLowerCase(), key);
    }

    for (const [key, value] of Object.entries(overrideEnvironment)) {
      const lowerCaseKey = key.toLowerCase();
      const existingKey = keysByLowerCase.get(lowerCaseKey);

      if (existingKey !== undefined) {
        delete mergedEnvironment[existingKey];
        keysByLowerCase.delete(lowerCaseKey);
      }

      if (value === undefined) {
        continue;
      }

      mergedEnvironment[key] = value;
      keysByLowerCase.set(lowerCaseKey, key);
    }

    return mergedEnvironment;
  }

  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined) {
      mergedEnvironment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrideEnvironment)) {
    if (value === undefined) {
      delete mergedEnvironment[key];
      continue;
    }

    mergedEnvironment[key] = value;
  }

  return mergedEnvironment;
}

function describeGitResult(result) {
  const details = [];

  if (result.error) {
    details.push(result.error.message.trim());
  }

  if (typeof result.status === 'number') {
    details.push(`Git exited with code ${result.status}`);
  }

  if (result.signal) {
    details.push(`signal ${result.signal}`);
  }

  const stderr = result.stderr?.trim();
  if (stderr) {
    details.push(`stderr: ${stderr}`);
  }

  const stdout = result.stdout?.trim();
  if (stdout) {
    details.push(`stdout: ${stdout}`);
  }

  return details.join('; ');
}

function encodePathSegment(value) {
  // Only lowercase ASCII letters are safe so case-insensitive filesystems
  // cannot collapse distinct cache keys like `Beta` and `beta`.
  // The escape delimiter itself (`~`) stays encoded, so escaped output such as
  // `~42~` cannot collide with a literal `~` in the source value.
  return Array.from(String(value), (character) => {
    if (/[a-z0-9_.-]/.test(character)) {
      return character;
    }

    return `~${character.codePointAt(0).toString(16)}~`;
  }).join('');
}

/**
 * Exposes the cached VS Code and ChromeDriver downloads inside a per-run ExTester storage
 * directory. Only the immutable download artifacts are projected; ExTester writes settings,
 * extensions, workspaces, and screenshots alongside them, and those must stay run-local so
 * concurrent runs cannot corrupt each other or the shared cache.
 */
function projectDownloadCache(result, storageDirectory) {
  fs.mkdirSync(storageDirectory, { recursive: true });
  projectCacheEntry(
    path.join(result.cacheDirectory, result.manifest.vscodeDirectory),
    path.join(storageDirectory, result.manifest.vscodeDirectory));
  projectCacheEntry(
    path.join(result.cacheDirectory, result.manifest.chromeDriverEntry),
    path.join(storageDirectory, result.manifest.chromeDriverEntry));
}

function projectCacheEntry(sourcePath, destinationPath) {
  fs.rmSync(destinationPath, { recursive: true, force: true });

  const source = fs.statSync(sourcePath);
  if (!source.isDirectory()) {
    // Older ExTester layouts place the driver binary directly in the storage root rather than in
    // a versioned subdirectory. ExTester chmods and can replace that file in-place, so copy it
    // instead of linking; a link would let one run mutate the shared cached original.
    fs.copyFileSync(sourcePath, destinationPath);
    return;
  }

  // Directory artifacts are only ever read, so a link avoids copying a multi-hundred-megabyte
  // VS Code install per run. Windows junctions require an absolute target and, unlike symlinks,
  // do not need Developer Mode or elevation.
  fs.symlinkSync(
    sourcePath,
    destinationPath,
    process.platform === 'win32' ? 'junction' : 'dir');
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CACHE_MANIFEST_NAME,
  resolveDownloadCacheRoot,
  getDownloadCacheEntryDirectory,
  ensureDownloadCache,
  projectDownloadCache,
  __testOnly__: {
    resolveGitCommonDir,
    assertCacheEntryTreeIsContained,
    discoverCacheArtifacts,
    encodePathSegment,
    mergeEnvironment,
  },
};

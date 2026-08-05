'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_SCHEMA_VERSION = 1;
const CACHE_MANIFEST_NAME = 'cache-manifest.json';

// Published entries are numbered generations under the key's group directory, and a generation
// name is only ever created, never reused for different content. That is what makes every
// deletion in this module safe: nothing a run deletes can turn out to be an entry another run
// published in the meantime.
const CACHE_ENTRY_NAME_PATTERN = /^entry-(\d{1,15})$/;
const CACHE_ENTRY_GENERATION_DIGITS = 6;
const CANDIDATE_DIRECTORY_PREFIX = 'candidate-';

// A publish only ever loses to a concurrent run, and a loser either adopts the winner or moves on
// to the next generation, so needing more than a couple of attempts means something structural is
// wrong rather than contended.
const MAX_PUBLISH_ATTEMPTS = 8;
const MAX_CANDIDATE_CREATE_ATTEMPTS = 3;

// Candidates only exist while a download is in flight, so a non-generation group child this old is
// debris left by a crash or by an older cache layout. Published generations are never swept on
// age; see sweepAbandonedGroupChildren.
const ABANDONED_GROUP_CHILD_AGE_MS = 6 * 60 * 60 * 1000;

// A candidate holding roughly a gigabyte would otherwise sit on disk for six hours if a Windows
// lock outlived one removal attempt, so the cache's own cleanup gets the same retry budget the
// runner uses for its per-run root.
const BEST_EFFORT_REMOVAL_RETRY_OPTIONS = { maxRetries: process.platform === 'win32' ? 20 : 0, retryDelay: 250 };

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

function getDownloadCacheEntryGroupDirectory(cacheRoot, { platform, architecture, vscodeVersion, extesterVersion }) {
  return path.join(
    cacheRoot,
    `v${CACHE_SCHEMA_VERSION}`,
    `${encodePathSegment(platform)}-${encodePathSegment(architecture)}`,
    `vscode-${encodePathSegment(vscodeVersion)}`,
    `extester-${encodePathSegment(extesterVersion)}`
  );
}

/**
 * Returns a cache entry holding the VS Code and ChromeDriver downloads for one key, populating a
 * new one first when none of the existing entries is usable.
 *
 * Entries are immutable and are never replaced in place. Each key owns a group directory whose
 * children are numbered generations (`entry-000001`, `entry-000002`, ...), and a generation is
 * published by renaming a fully populated candidate onto a name that does not exist yet. Readers
 * take the highest generation that validates, so a corrupt entry is stepped over by publishing the
 * next generation beside it instead of being deleted and replaced.
 *
 * That is what makes concurrency safe here without a lock: nothing this function deletes is
 * shared. A run only ever removes its own candidate, which has never been visible to anyone else,
 * or a group child that has been abandoned for hours. A run that observed a miss therefore cannot
 * destroy an entry another run published while it was downloading -- there is no canonical path
 * for it to overwrite, and the losing side of a publish adopts the winner.
 *
 * Two runs that cold-start at once still converge on a single entry. The generation a run
 * publishes to is derived from the same directory listing that failed to produce a usable entry,
 * so a run that cannot see an existing entry always aims at the generation that entry occupies and
 * collides with it rather than landing beside it. That costs a duplicate download when several
 * runs cold-start together, which is far cheaper than a lock protocol whose failure modes
 * (abandoned locks, half-released generations) can wedge every later run until a human deletes the
 * cache by hand.
 */
function ensureDownloadCache(options) {
  const normalizedOptions = normalizeEnsureDownloadCacheOptions(options);
  const expectedManifest = getExpectedManifestIdentity(normalizedOptions);
  const groupDirectory = getDownloadCacheEntryGroupDirectory(normalizedOptions.cacheRoot, expectedManifest);
  const cacheRootOptions = { cacheRoot: normalizedOptions.cacheRoot };

  const publishedEntry = selectPublishedCacheEntry(groupDirectory, expectedManifest, { ...cacheRootOptions, warnOnInvalid: true });
  if (publishedEntry) {
    // Sweeping on the hit path as well as the miss path matters: once a key is warm the miss path
    // never runs again, so a candidate abandoned by a crash would otherwise stay forever.
    sweepAbandonedGroupChildren(groupDirectory);
    return { cacheHit: true, cacheDirectory: publishedEntry.cacheDirectory, manifest: publishedEntry.manifest };
  }

  const candidateDirectory = createCacheEntryCandidate(normalizedOptions.cacheRoot, groupDirectory);

  let publishedCandidate = false;
  try {
    normalizedOptions.populate(candidateDirectory);
    pruneDownloadArchives(candidateDirectory);

    const artifacts = discoverCacheArtifacts(candidateDirectory, normalizedOptions.platform, normalizedOptions.architecture);
    assertCacheEntryTreeIsContained(candidateDirectory);
    writeCacheManifest(candidateDirectory, { ...expectedManifest, ...artifacts });

    const publishResult = publishCacheEntryCandidate(groupDirectory, candidateDirectory, expectedManifest, cacheRootOptions);
    publishedCandidate = publishResult.published;

    if (!publishedCandidate) {
      return { cacheHit: true, cacheDirectory: publishResult.cacheDirectory, manifest: publishResult.manifest };
    }

    const manifest = readCacheManifest(publishResult.cacheDirectory, expectedManifest, cacheRootOptions);
    return { cacheHit: false, cacheDirectory: publishResult.cacheDirectory, manifest };
  } finally {
    if (!publishedCandidate) {
      // The candidate was never published, so no other run can have observed it. This is the only
      // directory `ensureDownloadCache` deletes on the hot path, whether population failed or this
      // run adopted somebody else's entry.
      removeDirectoryBestEffort(candidateDirectory);
    }
  }
}

/**
 * Renames a populated candidate onto the next unused generation, or adopts an entry another run
 * published first.
 *
 * The listing that decides whether to adopt is the same listing that decides which generation to
 * take. Re-reading the directory to pick a target would reopen the duplicate-publish window this
 * closes: a run that has just failed to find an entry would see the winner's generation, skip past
 * it, and publish a redundant multi-hundred-megabyte copy beside it instead of colliding with it.
 */
function publishCacheEntryCandidate(groupDirectory, candidateDirectory, expectedManifest, { cacheRoot }) {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    const group = readCacheEntryGroup(groupDirectory);

    const adoptedEntry = selectValidCacheEntry(groupDirectory, group.entryNames, expectedManifest, { cacheRoot, warnOnInvalid: false });
    if (adoptedEntry) {
      return { published: false, ...adoptedEntry };
    }

    const entryDirectory = path.join(groupDirectory, formatCacheEntryName(group.highestGeneration + 1));
    try {
      fs.renameSync(candidateDirectory, entryDirectory);
      return { published: true, cacheDirectory: entryDirectory, manifest: null };
    } catch (error) {
      // Renaming onto an existing non-empty directory fails (ENOTEMPTY on POSIX, EEXIST/EPERM on
      // Windows), and onto a link it fails with ENOTDIR. Both mean a concurrent run took this
      // generation, so re-read and either adopt what it published or step to the next one.
      if (!isPublishRaceError(error)) {
        throw error;
      }
    }
  }

  throw new Error(`Unable to publish an E2E download cache entry under '${groupDirectory}' after ${MAX_PUBLISH_ATTEMPTS} attempts.`);
}

function selectPublishedCacheEntry(groupDirectory, expectedManifest, { cacheRoot, warnOnInvalid }) {
  const group = readCacheEntryGroup(groupDirectory);
  return selectValidCacheEntry(groupDirectory, group.entryNames, expectedManifest, { cacheRoot, warnOnInvalid });
}

function selectValidCacheEntry(groupDirectory, entryNames, expectedManifest, { cacheRoot, warnOnInvalid }) {
  for (const entryName of entryNames) {
    const cacheDirectory = path.join(groupDirectory, entryName);
    const manifest = tryReadCacheManifest(cacheDirectory, expectedManifest, { cacheRoot, warnOnInvalid });
    if (manifest) {
      return { cacheDirectory, manifest };
    }
  }

  return null;
}

/**
 * Lists the generations under a group directory, newest first, along with the highest generation
 * number seen.
 *
 * Names that are not ordinary directories still reserve their generation number even though they
 * cannot hold an entry. Skipping them there would make a publish aim at a name that is already
 * taken and can never be adopted, which turns a tampered-with entry into an unrecoverable one.
 */
function readCacheEntryGroup(groupDirectory) {
  let dirents;
  try {
    dirents = fs.readdirSync(groupDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { highestGeneration: 0, entryNames: [] };
    }

    throw error;
  }

  let highestGeneration = 0;
  const entries = [];

  for (const dirent of dirents) {
    const match = CACHE_ENTRY_NAME_PATTERN.exec(dirent.name);
    if (!match) {
      continue;
    }

    const generation = Number(match[1]);
    highestGeneration = Math.max(highestGeneration, generation);

    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, generation });
    }
  }

  entries.sort((left, right) => right.generation - left.generation);

  return { highestGeneration, entryNames: entries.map(entry => entry.name) };
}

function formatCacheEntryName(generation) {
  return `entry-${String(generation).padStart(CACHE_ENTRY_GENERATION_DIGITS, '0')}`;
}

function createCacheEntryCandidate(cacheRoot, groupDirectory) {
  let lastError;

  for (let attempt = 0; attempt < MAX_CANDIDATE_CREATE_ATTEMPTS; attempt++) {
    ensureTrustedCacheEntryGroupDirectory(cacheRoot, groupDirectory);
    sweepAbandonedGroupChildren(groupDirectory);

    try {
      return fs.mkdtempSync(path.join(groupDirectory, CANDIDATE_DIRECTORY_PREFIX));
    } catch (error) {
      // A concurrent run repairing a tampered-with group directory detaches and recreates it,
      // which shows up here as a transient ENOENT. Rebuilding it and retrying is enough.
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Makes sure the group directory exists as an ordinary directory inside the cache root.
 *
 * Every candidate is created inside this directory, so a link or a squatting file here would send
 * the whole download outside the cache root. Rejecting it outright would wedge the cache for
 * everyone until a human intervened, so the offending leaf is detached instead -- never its
 * target, and never as a recursive delete, so nothing the cache does not own can be destroyed.
 */
function ensureTrustedCacheEntryGroupDirectory(cacheRoot, groupDirectory) {
  assertTrustedEntryAncestry(cacheRoot, groupDirectory);
  detachUntrustedCacheEntryGroupDirectory(groupDirectory);
  fs.mkdirSync(groupDirectory, { recursive: true });
  assertTrustedCacheEntryDirectory(groupDirectory, cacheRoot);
}

function detachUntrustedCacheEntryGroupDirectory(groupDirectory) {
  let stats;
  try {
    stats = fs.lstatSync(groupDirectory);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  // `lstat` reports a link as a link rather than as the directory it points at, so an ordinary
  // directory is the only case that needs nothing done to it.
  if (stats.isDirectory()) {
    return;
  }

  try {
    if (stats.isSymbolicLink()) {
      removeLink(groupDirectory);
      return;
    }

    fs.unlinkSync(groupDirectory);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    // A concurrent run may have replaced the link with a real directory between the check above
    // and this removal. Reporting the failure here would be misleading; the trust check that runs
    // after the directory is created decides whether the result is usable.
    writeWarning(`Unable to detach untrusted E2E download cache path '${groupDirectory}': ${describeOperationError(error)}`);
  }
}

/**
 * Deletes the archives ExTester leaves in the storage root after unpacking them.
 *
 * ExTester downloads `<version>-stable.zip` (or `.tar.gz` on Linux) and
 * `<version>-chromedriver-<platform>.zip`, unpacks them next to themselves, and never removes
 * them. On a real macOS entry that is 352 MB of a 1.3 GB entry, kept forever and multiplied by
 * every cached version combination.
 *
 * Dropping them is safe because ExTester only consults an archive when it is about to download:
 * `downloadVSCode` skips the whole download-and-unpack block once the executable exists and
 * reports a matching version, and `downloadChromeDriver` returns before touching the archive once
 * the driver binary reports a matching version. ExTester deletes these archives itself when run
 * with `--no_cache`, for the same reason.
 *
 * This runs against a candidate directory only. A published entry is shared with concurrent runs
 * that are validating and reading it, so it is never mutated in place.
 */
function pruneDownloadArchives(candidateDirectory) {
  let entries;
  try {
    entries = fs.readdirSync(candidateDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return 0;
    }

    throw error;
  }

  let reclaimedBytes = 0;
  for (const entry of entries) {
    // Only plain files directly in the storage root are archives ExTester downloaded. Nested
    // archives belong to the unpacked applications, and a link is never ours to delete.
    if (!entry.isFile() || !isDownloadArchiveName(entry.name)) {
      continue;
    }

    const archivePath = path.join(candidateDirectory, entry.name);
    try {
      reclaimedBytes += fs.statSync(archivePath).size;
      fs.unlinkSync(archivePath);
    } catch (error) {
      // The cache entry is perfectly usable with the archive still present, so a failure here is
      // only a missed saving.
      writeWarning(`Unable to remove downloaded archive '${archivePath}': ${describeOperationError(error)}`);
    }
  }

  return reclaimedBytes;
}

function isDownloadArchiveName(name) {
  const lowerCaseName = name.toLowerCase();
  return lowerCaseName.endsWith('.zip') || lowerCaseName.endsWith('.tar.gz') || lowerCaseName.endsWith('.tgz');
}

/**
 * Removes group children that are not published generations and have not been touched for hours.
 *
 * Published generations are deliberately out of scope. An entry is never written to after it is
 * published, so its timestamp records when it was created rather than when it was last used, and a
 * warm entry that has served every run for a day is indistinguishable from abandoned debris by
 * age alone. Two things would go wrong if one were swept: a run whose projections point straight
 * at it would have its VS Code and ChromeDriver deleted mid-test, and the freed generation number
 * would be republished with different content, which is the single assumption the rest of this
 * module rests on. Neither is hypothetical - validation failures route a run onto the miss path,
 * and `tryReadCacheManifest` cannot tell a genuinely corrupt entry from a transient EMFILE or a
 * momentary antivirus lock during the full-tree walk, so a healthy entry can look invalid to one
 * run while another is happily using it.
 *
 * Reclaiming superseded generations safely would need reader leases, which is not worth building
 * for the occasional duplicate a cold-start race leaves behind. What is swept instead is
 * candidates abandoned by a crash and debris from an older cache layout, neither of which a live
 * run holds, and the age gate is what keeps this from racing a candidate still being downloaded.
 */
function sweepAbandonedGroupChildren(groupDirectory) {
  let dirents;
  try {
    dirents = fs.readdirSync(groupDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return;
    }

    throw error;
  }

  for (const dirent of dirents) {
    if (CACHE_ENTRY_NAME_PATTERN.test(dirent.name)) {
      continue;
    }

    const candidatePath = path.join(groupDirectory, dirent.name);
    try {
      if (Date.now() - fs.lstatSync(candidatePath).mtimeMs < ABANDONED_GROUP_CHILD_AGE_MS) {
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
    removePathWithoutFollowingLinks(directoryPath, BEST_EFFORT_REMOVAL_RETRY_OPTIONS);
  } catch (error) {
    // Losing a candidate or an abandoned generation is not fatal; the next sweep retries it.
    writeWarning(`Unable to remove '${directoryPath}': ${describeOperationError(error)}`);
  }
}

/**
 * Deletes a path, treating every link as a leaf instead of descending into its target.
 *
 * `fs.rmSync(..., { recursive: true })` descends through Windows junctions, so using it here would
 * delete data the cache does not own. Three call sites make that reachable: removing a candidate
 * or an abandoned generation that someone replaced with a junction wipes the junction's target,
 * re-projecting into a storage directory deletes the previous run's junction, and cleaning up a
 * per-run temporary root deletes the junctions it was just given - all of which point at the
 * shared cache itself.
 *
 * The walk is written by hand rather than delegating subdirectories to `fs.rmSync`, because a
 * rejected cache entry is exactly the kind of tree that contains an escaping link - that is why it
 * failed validation - and those links can sit at any depth.
 *
 * `maxRetries`/`retryDelay` behave the way `fs.rmSync` documents them for recursive removals, but
 * they are applied by an explicit loop here: Node ignores both options unless `recursive` is set,
 * and every removal below is deliberately non-recursive so links are never followed.
 */
function removePathWithoutFollowingLinks(targetPath, options = {}) {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    removeLink(targetPath, options);
    return;
  }

  if (!stats.isDirectory()) {
    removeWithRetries(() => fs.rmSync(targetPath, { force: true }), options);
    return;
  }

  for (const entry of fs.readdirSync(targetPath)) {
    removePathWithoutFollowingLinks(path.join(targetPath, entry), options);
  }

  removeEmptyDirectory(targetPath, options);
}

function removeEmptyDirectory(directoryPath, options) {
  try {
    removeWithRetries(() => fs.rmdirSync(directoryPath), options);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function removeLink(linkPath, options = {}) {
  // Retry the pair rather than the unlink alone. Windows reports EPERM for unlink on a directory
  // junction, which is the signal to use rmdir instead, not a transient lock - retrying the unlink
  // first would burn the whole backoff budget on every junction before ever reaching the fallback.
  removeWithRetries(() => detachLink(linkPath), options);
}

function detachLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    // A directory symlink and a junction are both reparse points on a directory, and rmdir removes
    // them without touching what they point at.
    try {
      fs.rmdirSync(linkPath);
    } catch {
      throw error;
    }
  }
}

/**
 * Retries a removal the way `fs.rmSync` retries recursive ones: linear backoff, growing by
 * `retryDelay` on each attempt, over the error codes that indicate a transient lock.
 *
 * Node applies `maxRetries`/`retryDelay` only when `recursive` is true
 * (https://nodejs.org/api/fs.html#fsrmsyncpath-options), so passing them to the single-path
 * removals in this module would silently do nothing. That matters on Windows, where a file can
 * stay locked for a moment after the process holding it exits, which is exactly the case the
 * per-run temporary root cleanup hits.
 */
function removeWithRetries(remove, { maxRetries = 0, retryDelay = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      remove();
      return;
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableRemovalError(error)) {
        throw error;
      }

      sleepSync((attempt + 1) * retryDelay);
    }
  }
}

function isRetryableRemovalError(error) {
  return Boolean(error) && ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(error.code);
}

function sleepSync(durationMs) {
  if (durationMs <= 0) {
    return;
  }

  // Everything else in this module is synchronous, so there is no event loop to yield to.
  // `Atomics.wait` on a throwaway buffer is the only synchronous sleep Node offers.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
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

/**
 * Writes the manifest that turns a populated candidate into a publishable entry.
 *
 * The manifest is written under a temporary name and renamed into place so a reader validating a
 * generation can never observe a half-written file. Rejecting an otherwise fine entry over a torn
 * read would cost a needless multi-hundred-megabyte re-download.
 */
function writeCacheManifest(cacheDirectory, manifest) {
  // The candidate is private to this process until it is published, so a single temporary name is
  // enough to keep this collision-free.
  const temporaryManifestPath = path.join(cacheDirectory, `${CACHE_MANIFEST_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporaryManifestPath, path.join(cacheDirectory, CACHE_MANIFEST_NAME));
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
 * Rejects a cache entry group whose existing ancestors are not ordinary directories inside the
 * cache root. Missing ancestors are fine; they are created during population.
 */
function assertTrustedEntryAncestry(cacheRoot, cacheDirectory) {
  const realCacheRoot = resolveTrustBoundaryRootDirectory(cacheRoot);
  const relativeEntryPath = path.relative(cacheRoot, cacheDirectory);
  if (relativeEntryPath.length === 0 || relativeEntryPath.startsWith('..') || path.isAbsolute(relativeEntryPath)) {
    throw new Error(`Cache entry '${cacheDirectory}' must be contained within '${cacheRoot}'.`);
  }

  let candidatePath = cacheRoot;
  const segments = relativeEntryPath.split(path.sep).filter(segment => segment.length > 0);

  // Only the ancestors are checked here, not the group directory itself. A tampered-with group
  // directory has to be repaired rather than reported, or one bad link would wedge every later
  // run, so `ensureTrustedCacheEntryGroupDirectory` detaches and recreates the leaf and then
  // validates it. Rejecting it here would take that recovery away.
  for (let index = 0; index < segments.length - 1; index++) {
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
  // A previous run leaves a link here that points into the shared cache, so the stale destination
  // must be detached rather than deleted recursively.
  removePathWithoutFollowingLinks(destinationPath);

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
  getDownloadCacheEntryGroupDirectory,
  ensureDownloadCache,
  projectDownloadCache,
  removePathWithoutFollowingLinks,
  __testOnly__: {
    resolveGitCommonDir,
    assertCacheEntryTreeIsContained,
    discoverCacheArtifacts,
    encodePathSegment,
    formatCacheEntryName,
    mergeEnvironment,
  },
};

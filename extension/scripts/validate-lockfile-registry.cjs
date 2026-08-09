const fs = require('fs');

const internalFeedOrigin = 'https://pkgs.dev.azure.com';
const internalFeedPathPrefix = '/dnceng/public/_packaging/dotnet-public-npm/';
const lockfilePath = 'yarn.lock';

const resolved = fs.readFileSync(lockfilePath, 'utf8')
  .split(/\r?\n/)
  .filter(line => /^\s*resolved\s+"/.test(line));

if (!resolved.length) {
  throw new Error(`extension/${lockfilePath} does not contain any resolved entries. Regenerate it through the internal feed before restoring.`);
}

// A yarn.lock resolved line looks like:
//   resolved "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/registry/-/@types/node/-/node-20.0.0.tgz#deadbeef..."
// The trailing `#sha1/sha512-...` integrity fragment is normal and legitimate;
// `new URL()` parses it as `.hash` rather than part of the host or path, so it
// does not need to be stripped before parsing.
//
// This must reject the URL wholesale on any parse failure and must compare the
// exact origin (protocol + hostname), not a substring of the raw line. A
// substring/`.includes()` check can be defeated by a hostile host that merely
// contains the feed string in its path (`https://evil.example/pkgs.dev.azure.com/...`),
// a hostname suffix (`https://pkgs.dev.azure.com.evil.example/...`), a URL
// fragment (`https://evil.example/x.tgz#pkgs.dev.azure.com/...`), or a
// downgrade to plaintext `http://`.
function isInternalFeedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'pkgs.dev.azure.com'
      && parsed.pathname.startsWith(internalFeedPathPrefix);
  }
  catch {
    return false;
  }
}

const bad = resolved.filter(line => {
  const match = /^\s*resolved\s+"([^"]*)"/.exec(line);
  return !match || !isInternalFeedUrl(match[1]);
});

if (bad.length) {
  throw new Error(`extension/${lockfilePath} contains resolved entries outside the internal dotnet-public-npm feed (${internalFeedOrigin}${internalFeedPathPrefix}). Regenerate it through the internal feed before restoring. First offender -> ${bad[0]}`);
}

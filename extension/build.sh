#!/bin/bash
set -e

# Pinned Corepack shim version. Node.js >= 16.10 bundles a Corepack, but the
# bundled version drifts with each Node release and Corepack is on track to be
# unbundled from Node entirely (see https://github.com/nodejs/node/issues/54647).
# Installing a pinned Corepack from npm makes the build reproducible regardless
# of which Node version a developer or CI runner happens to have.
COREPACK_VERSION="0.34.7"

# Yarn version is pinned in extension/package.json via the "packageManager"
# field, which Corepack reads automatically when invoked from this directory.

# Point Corepack at the dnceng internal npm mirror unless the caller already
# set a registry. Corepack does NOT read .npmrc, so we have to feed it through
# its own env var. See https://github.com/nodejs/corepack#environment-variables.
# Override locally with `COREPACK_NPM_REGISTRY=<url> ./build.sh`. To bypass the
# internal mirror, set it to `https://registry.npmjs.org/`.
: "${COREPACK_NPM_REGISTRY:=https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/}"
: "${COREPACK_ENABLE_DOWNLOAD_PROMPT:=0}"
export COREPACK_NPM_REGISTRY COREPACK_ENABLE_DOWNLOAD_PROMPT

echo "Checking prerequisites..."

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    exit 1
fi

# npm is required to install our pinned Corepack. It ships with every official
# Node.js distribution, so this should only fail on broken installs.
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not available. Reinstall Node.js so npm is on PATH."
    exit 1
fi

# Check for VS Code or VS Code Insiders
if ! command -v code &> /dev/null && ! command -v code-insiders &> /dev/null; then
    echo "Error: VS Code or VS Code Insiders is not installed or not in PATH."
    echo "Please install VS Code or VS Code Insiders and ensure it's added to your PATH."
    exit 1
fi

# Check for dotnet
if ! command -v dotnet &> /dev/null; then
    echo "Error: .NET SDK is not installed. Please install .NET SDK first."
    echo "Use the restore script at the repo root."
    exit 1
fi

echo "All prerequisites satisfied."

# Ensure we run from the extension directory so corepack/yarn pick up
# extension/.npmrc and extension/package.json (which holds the packageManager pin).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "Installing pinned Corepack ${COREPACK_VERSION}..."
# Reinstall every time so we overwrite any older Corepack shim that Node.js
# may have placed on PATH ahead of npm's global prefix. npm global installs do
# not use the project .npmrc, so pass the registry explicitly.
npm install --global --registry "$COREPACK_NPM_REGISTRY" "corepack@${COREPACK_VERSION}"

# Verify the version actually on PATH matches our pin. If a system-bundled
# Corepack shim shadows the npm-global install (common on Windows; possible on
# macOS/Linux when /usr/local/bin precedes the npm prefix), `npm install -g`
# can "succeed" while subsequent `corepack` calls still resolve to the bundled
# version. Fail loudly here so we don't silently run with the wrong tool.
installed_corepack=$(corepack --version 2>/dev/null || echo "")
if [ "$installed_corepack" != "$COREPACK_VERSION" ]; then
    echo "Error: corepack version mismatch: expected $COREPACK_VERSION, got '$installed_corepack'."
    echo "The bundled Corepack on PATH may be taking precedence over the npm-global install."
    echo "Ensure your npm global bin directory comes before any other Node.js install on PATH,"
    echo "or use a Node version manager (nvm, asdf, fnm) that places the npm prefix appropriately."
    exit 1
fi

echo ""
echo "Enabling Corepack package manager shims..."
corepack enable

echo ""
echo "Preparing Yarn from packageManager pin in package.json..."
# `corepack prepare --activate` (no args) reads the "packageManager" field from
# the package.json in the current directory and provisions/activates that exact
# version. See https://github.com/nodejs/corepack#corepack-prepare-.
corepack prepare --activate

echo ""
echo "Running yarn install..."
corepack yarn install --frozen-lockfile --non-interactive

echo ""
echo "Running yarn compile..."
corepack yarn compile

echo ""
echo "Building Aspire CLI..."
dotnet build ../src/Aspire.Cli/Aspire.Cli.csproj

echo ""
echo "Build completed successfully!"

#!/bin/bash
set -e

# Pinned Corepack shim version. Node.js >= 16.10 bundles a Corepack, but the
# bundled version drifts with each Node release and Corepack is on track to be
# unbundled from Node entirely (see https://github.com/nodejs/node/issues/54647).
# Installing a pinned Corepack from npm makes the build reproducible regardless
# of which Node version a developer or CI runner happens to have.
COREPACK_VERSION="0.34.7"

# Yarn version is pinned in extension/package.json via the "packageManager"
# field, which Corepack reads automatically. To change the Yarn release, edit
# packageManager there and update the inline pin in extension/Extension.proj
# if any commands need to predate the working-directory switch.

# Point Corepack at the dnceng internal npm mirror unless the caller already
# set a registry. Corepack does NOT read .npmrc, so we have to feed it through
# its own env var. See https://github.com/nodejs/corepack#environment-variables.
# Override locally with `COREPACK_NPM_REGISTRY=<url> ./build.sh` or unset to use
# the public npm registry.
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
# may have placed on PATH ahead of npm's global prefix.
npm install --global "corepack@${COREPACK_VERSION}"

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

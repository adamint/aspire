#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"

# Pinned Corepack shim version. Node.js >= 16.10 bundles a Corepack, but the
# bundled version drifts with each Node release and Corepack is on track to be
# unbundled from Node entirely (see https://github.com/nodejs/node/issues/54647).
# Installing a pinned Corepack from npm makes the build reproducible regardless
# of which Node version a developer or CI runner happens to have.
$CorepackVersion = "0.34.7"

# Yarn version is pinned in extension/package.json via the "packageManager"
# field, which Corepack reads automatically. To change the Yarn release, edit
# packageManager there and update the inline pin in extension/Extension.proj
# if any commands need to predate the working-directory switch.

# Point Corepack at the dnceng internal npm mirror unless the caller already
# set a registry. Corepack does NOT read .npmrc, so we have to feed it through
# its own env var. See https://github.com/nodejs/corepack#environment-variables.
# Override locally with `$env:COREPACK_NPM_REGISTRY = '<url>'; ./build.ps1` or
# remove the env var to use the public npm registry.
if (-not $env:COREPACK_NPM_REGISTRY) {
    $env:COREPACK_NPM_REGISTRY = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"
}
if (-not $env:COREPACK_ENABLE_DOWNLOAD_PROMPT) {
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
}

Write-Host "Checking prerequisites..."

# Check for Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Error: Node.js is not installed. Please install Node.js first."
    exit 1
}

# npm is required to install our pinned Corepack. It ships with every official
# Node.js distribution, so this should only fail on broken installs.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "Error: npm is not available. Reinstall Node.js so npm is on PATH."
    exit 1
}

# Check for VS Code or VS Code Insiders
$hasVSCode = Get-Command code -ErrorAction SilentlyContinue
$hasVSCodeInsiders = Get-Command code-insiders -ErrorAction SilentlyContinue

if (-not $hasVSCode -and -not $hasVSCodeInsiders) {
    Write-Error "Error: VS Code or VS Code Insiders is not installed or not in PATH."
    Write-Host "Please install VS Code or VS Code Insiders and ensure it's added to your PATH."
    exit 1
}

# Check for dotnet
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "Error: .NET SDK is not installed. Please install .NET SDK first."
    Write-Host "Use the restore script at the repo root."
    exit 1
}

Write-Host "All prerequisites satisfied."

# Ensure we run from the extension directory so corepack/yarn pick up
# extension/.npmrc and extension/package.json (which holds the packageManager pin).
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "Installing pinned Corepack $CorepackVersion..."
# Reinstall every time so we overwrite any older Corepack shim that Node.js
# may have placed on PATH ahead of npm's global prefix.
npm install --global "corepack@$CorepackVersion"

if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install -g corepack@$CorepackVersion failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Enabling Corepack package manager shims..."
corepack enable

if ($LASTEXITCODE -ne 0) {
    Write-Error "corepack enable failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Preparing Yarn from packageManager pin in package.json..."
# `corepack prepare --activate` (no args) reads the "packageManager" field from
# the package.json in the current directory and provisions/activates that exact
# version. See https://github.com/nodejs/corepack#corepack-prepare-.
corepack prepare --activate

if ($LASTEXITCODE -ne 0) {
    Write-Error "corepack prepare --activate failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Running yarn install..."
corepack yarn install --frozen-lockfile --non-interactive

if ($LASTEXITCODE -ne 0) {
    Write-Error "yarn install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Running yarn compile..."
corepack yarn compile

if ($LASTEXITCODE -ne 0) {
    Write-Error "yarn compile failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Building Aspire CLI..."
dotnet build ../src/Aspire.Cli/Aspire.Cli.csproj

if ($LASTEXITCODE -ne 0) {
    Write-Error "dotnet build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Build completed successfully!"

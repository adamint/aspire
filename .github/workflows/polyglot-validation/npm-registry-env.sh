# shellcheck shell=bash
# Points every npm-ecosystem package manager at the approved dotnet-public-npm feed.
#
# Source this (do not execute it) from any polyglot validation script that acquires npm packages,
# directly or indirectly, before the first acquisition happens:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/npm-registry-env.sh"
#
# It lives in its own file rather than inline in one script because the guarantee is a property of
# the whole polyglot job, not of a single script. A new validation script that installs packages
# needs one `source` line instead of re-deriving which environment variable each package manager
# reads, which is the kind of detail that is easy to get subtly wrong.
#
# ---------------------------------------------------------------------------------------------
# Why the environment, and not a config file
#
# The repository-root .npmrc does not reach the AppHosts under tests/PolyglotAppHosts. npm resolves
# project config from `localPrefix`, the nearest ancestor directory containing package.json or
# node_modules, which for every AppHost is the AppHost directory itself. npm therefore reads that
# directory's (non-existent) .npmrc and falls back to the public registry. Environment variables
# outrank project config, so exporting them is what actually reaches the AppHosts.
#
# Committed lockfiles pin absolute tarball URLs and cover most AppHosts, but two shapes have no such
# protection: an AppHost with no lockfile has to resolve everything remotely, and Yarn Berry
# lockfiles record `resolution: "ms@npm:2.1.3"` locators with no host in them, so Berry re-resolves
# through whatever registry is configured.
#
# The knobs are not interchangeable, so each manager gets the one it actually reads:
#   npm, pnpm  npm_config_registry - npm's environment form of an .npmrc key, and pnpm honors it.
#   bun        BUN_CONFIG_REGISTRY - bun also reads npm_config_registry, so both are set.
#   Yarn Berry YARN_NPM_REGISTRY_SERVER - Berry ignores .npmrc and npm_config_registry entirely. It
#              maps YARN_<SCREAMING_SNAKE> onto the .yarnrc.yml setting of the same name, and it has
#              no --registry flag, so the environment is the only lever. Without this, Berry uses its
#              built-in default of https://registry.yarnpkg.com. See
#              https://yarnpkg.com/configuration/yarnrc#npmRegistryServer.
#   corepack   COREPACK_NPM_REGISTRY - AppHosts declare `packageManager`, so if corepack shims are
#              active it fetches the pinned manager itself before any install begins.

NPM_REGISTRY="${NPM_REGISTRY:-https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/}"

export NPM_REGISTRY
export npm_config_registry="$NPM_REGISTRY"
export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
export BUN_CONFIG_REGISTRY="$NPM_REGISTRY"
export YARN_NPM_REGISTRY_SERVER="$NPM_REGISTRY"
export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"

# Trailing slashes are not significant to any of these managers, and they do not all echo the value
# back verbatim, so compare against a single normalized form.
check_manager_registry() {
    local manager="$1"
    local reported="$2"

    if [ "${reported%/}" != "${NPM_REGISTRY%/}" ]; then
        echo "  ❌ $manager resolves packages from '${reported:-<unset>}' instead of the approved feed '$NPM_REGISTRY'"
        return 1
    fi

    echo "  ✅ $manager -> $reported"
    return 0
}

# Exporting the variables above is not proof that they took effect. A package manager bump could
# rename a setting, or an image could bake in a conflicting config with higher precedence, and the
# installs would quietly fall back to the public registry with the job still green. Ask each manager
# what it actually resolved so that drift fails loudly here, before anything is downloaded.
#
# Bun has no config-read command, so it is covered by the two environment variables above rather than
# by an assertion.
verify_registry_configuration() {
    local failed=0

    echo "Package registry configuration:"

    if command -v npm &> /dev/null; then
        check_manager_registry "npm" "$(npm config get registry 2>/dev/null || true)" || failed=1
    fi

    if command -v pnpm &> /dev/null; then
        check_manager_registry "pnpm" "$(pnpm config get registry 2>/dev/null || true)" || failed=1
    fi

    if command -v yarn &> /dev/null; then
        # Yarn Classic does not understand npmRegistryServer and prints "undefined" for it, while
        # still exiting 0. It also ignores npm_config_registry, so there is no way to point it at the
        # approved feed from the environment. A Classic binary on PATH would still be used to install
        # a Berry AppHost, so surface it here instead of letting it reach the public registry.
        if [[ "$(yarn --version 2>/dev/null)" == 1.* ]]; then
            echo "  ❌ yarn on PATH is Yarn Classic ($(yarn --version 2>/dev/null)), which cannot be pointed at the approved feed. Install Yarn 4 or later."
            failed=1
        else
            check_manager_registry "yarn" "$(yarn config get npmRegistryServer 2>/dev/null || true)" || failed=1
        fi
    fi

    if [ "$failed" -ne 0 ]; then
        echo "❌ Refusing to install: packages would be downloaded from outside the approved feed."
        exit 1
    fi
}

verify_registry_configuration

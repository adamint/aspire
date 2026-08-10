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
#   corepack   COREPACK_ENABLE_NETWORK=0 - AppHosts declare `packageManager`, so if corepack shims
#              are active it fetches the pinned manager itself before any install begins, and that
#              fetch cannot be pointed at the approved feed. Two independent reasons:
#              COREPACK_NPM_REGISTRY only reaches Azure Artifacts' `/<package>/<version>` metadata
#              route, which the feed answers 404 for even when the package exists (see the npm
#              mirror note in extension/CONTRIBUTING.md), and Yarn is not fetched over npm at all --
#              corepack 0.34.7 with `packageManager: yarn@3.6.4` reports
#              `can't reach https://repo.yarnpkg.com/3.6.4/packages/yarnpkg-cli/bin/yarn.js`.
#              Exporting COREPACK_NPM_REGISTRY would advertise a source corepack cannot use while
#              leaving the yarn path on the public host, so forbid hydration instead. The image
#              preinstalls the exact managers, so nothing legitimate needs to download one.

#   npm scopes  NPM_CONFIG_USERCONFIG / NPM_CONFIG_GLOBALCONFIG - see below.

APPROVED_NPM_REGISTRY="https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"

# The preflight's authority has to be independent of NPM_REGISTRY. If NPM_REGISTRY itself were
# accepted as the expected value, a caller could set it to the public registry and every manager
# check below would only prove the bad value propagated.
if [ -n "${NPM_REGISTRY:-}" ] && [ "${NPM_REGISTRY%/}" != "${APPROVED_NPM_REGISTRY%/}" ]; then
    echo "❌ NPM_REGISTRY override '${NPM_REGISTRY}' is not the approved feed '${APPROVED_NPM_REGISTRY}'."
    echo "   Refusing to install packages that would come from an unapproved registry."
    exit 1
fi

NPM_REGISTRY="$APPROVED_NPM_REGISTRY"

export NPM_REGISTRY
export npm_config_registry="$NPM_REGISTRY"
export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
export BUN_CONFIG_REGISTRY="$NPM_REGISTRY"
export YARN_NPM_REGISTRY_SERVER="$NPM_REGISTRY"
export COREPACK_ENABLE_NETWORK=0

# ---------------------------------------------------------------------------------------------
# Why the default registry alone is not enough
#
# `registry` sets the default only. A per-scope `@scope:registry` key is a separate setting that
# always wins for that scope, and neither npm_config_registry nor `npm --registry` overrides it.
# Measured with npm 11.4.2, a user-level `@types:registry=https://scoped.example.invalid/` and
# npm_config_registry pointing at the approved feed:
#
#   npm config get registry        -> https://pkgs.dev.azure.com/.../npm/registry/
#   npm config get @types:registry -> https://scoped.example.invalid/
#   npm install @types/node        -> request to https://scoped.example.invalid/@types%2fnode
#
# The AppHosts install scoped packages (@types/*, @esbuild/*), so an ambient user- or global-level
# scoped key in the image would silently redirect exactly the packages the guard exists to protect.
# Point both config paths at files this script owns so no ambient scoped key can apply.
NPM_REGISTRY_CONFIG_DIR="$(mktemp -d)"
printf 'registry=%s\n' "$NPM_REGISTRY" > "$NPM_REGISTRY_CONFIG_DIR/npmrc"
: > "$NPM_REGISTRY_CONFIG_DIR/globalrc"
export NPM_CONFIG_USERCONFIG="$NPM_REGISTRY_CONFIG_DIR/npmrc"
export NPM_CONFIG_GLOBALCONFIG="$NPM_REGISTRY_CONFIG_DIR/globalrc"

# ---------------------------------------------------------------------------------------------
# Bun needs its own isolation
#
# Bun does not honor NPM_CONFIG_USERCONFIG, and BUN_CONFIG_REGISTRY replaces only the default
# registry, so neither setting above covers a per-scope key. Measured with bun 1.3.14 against a
# project depending on @types/semver, with an ambient `@types:registry=http://scoped.example.invalid/`
# in $HOME/.npmrc and BUN_CONFIG_REGISTRY, npm_config_registry and NPM_CONFIG_USERCONFIG all
# pointing at a registry that works:
#
#   HOME=<dir holding that .npmrc>                       -> error: FailedToOpenSocket downloading
#                                                             package manifest @types/semver
#   HOME=<clean dir>                                     -> 1 package installed
#
# Bun does read XDG_CONFIG_HOME, and it supersedes HOME once set. Same project, same bad key:
#
#   HOME=<bad>,  XDG_CONFIG_HOME=<clean>                 -> 1 package installed
#   HOME=<clean>, XDG_CONFIG_HOME=<bad>                  -> FailedToOpenSocket
#   HOME=<bad>,  XDG_CONFIG_HOME=<this script's dir>     -> 1 package installed
#
# So own that directory. The .npmrc here is dot-prefixed because that is the name bun looks for in a
# config home; NPM_CONFIG_USERCONFIG above names an explicit path and does not have to match it.
printf 'registry=%s\n' "$NPM_REGISTRY" > "$NPM_REGISTRY_CONFIG_DIR/.npmrc"
export XDG_CONFIG_HOME="$NPM_REGISTRY_CONFIG_DIR"

# Trailing slashes are not significant to any of these managers, and they do not all echo the value
# back verbatim, so compare against a single normalized form.
check_manager_registry() {
    local manager="$1"
    local reported="$2"

    if [ "${reported%/}" != "${APPROVED_NPM_REGISTRY%/}" ]; then
        echo "  ❌ $manager resolves packages from '${reported:-<unset>}' instead of the approved feed '$APPROVED_NPM_REGISTRY'"
        return 1
    fi

    echo "  ✅ $manager -> $reported"
    return 0
}

# Every query below runs from NPM_REGISTRY_CONFIG_DIR rather than the caller's directory. These
# managers refuse to answer inside a project claimed by a different one — from an AppHost whose
# package.json says `"packageManager": "yarn@4.14.1"`, `pnpm config get registry` exits 1 with
# "This project is configured to use yarn" and prints nothing. Reading that empty output as a
# registry value would fail the job for a project that is configured correctly, so ask in a
# directory that belongs to no project and the answer depends only on the environment.
#
# What this deliberately does not cover is a per-project .npmrc or .yarnrc.yml, which is invisible
# from here. That is asserted statically instead, by
# NpmLockfileRegistryTests.PolyglotFixtures_DoNotOverrideTheRegistry.
config_in_neutral_directory() {
    (cd "$NPM_REGISTRY_CONFIG_DIR" && "$@" 2>/dev/null) || true
}

# Same neutral directory, but the command's exit status survives. `config_in_neutral_directory`
# swallows it with `|| true`, which is right for the checks that treat "no answer" as "nothing
# configured". It is wrong wherever an unanswered query and a genuinely empty configuration have to
# be told apart: a renamed setting or a yarn that fails to start would otherwise read as "no scoped
# registries" and let an ambient scope through with the job green.
config_in_neutral_directory_strict() {
    (cd "$NPM_REGISTRY_CONFIG_DIR" && "$@" 2>/dev/null)
}

# Exporting the variables above is not proof that they took effect. A package manager bump could
# rename a setting, or an image could bake in a conflicting config with higher precedence, and the
# installs would quietly fall back to the public registry with the job still green. Ask each manager
# what it actually resolved so that drift fails loudly here, before anything is downloaded.
#
# Bun has no config-read command, so it is covered by the two environment variables above rather than
# by an assertion.
# A scoped key that survives the config paths above — from a project .npmrc, or from a source a
# future npm adds — would redirect only the scoped packages, which is the easiest form of this drift
# to miss. Enumerate every "@scope:registry" npm reports and require each to be the approved feed.
#
# `npm config list` prints one setting per line, quoted:
#   @types:registry = "https://scoped.example.invalid/"
#   registry = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public-npm/npm/registry/"
# Comment lines beginning with ';' name the file each block came from and are skipped by the match.
check_scoped_registries() {
    local failed=0
    local scope reported line

    while IFS= read -r line; do
        scope="${line%%:registry*}"
        reported="${line#*= }"
        reported="${reported%\"}"
        reported="${reported#\"}"

        if [ "${reported%/}" != "${APPROVED_NPM_REGISTRY%/}" ]; then
            echo "  ❌ npm resolves $scope packages from '$reported' instead of the approved feed '$APPROVED_NPM_REGISTRY'"
            failed=1
        else
            echo "  ✅ npm $scope -> $reported"
        fi
    done < <(config_in_neutral_directory npm config list | grep -E '^@[^:]+:registry = ' || true)

    return "$failed"
}

# Yarn keeps scoped registries in `npmScopes.<scope>.npmRegistryServer`, a namespace entirely
# separate from the top-level `npmRegistryServer` the check below reads. Berry consults the scoped
# entry first, and the AppHosts install scoped packages (@types/*, @esbuild/*), so a scope declared
# in an ambient ~/.yarnrc.yml redirects exactly those while `yarn config get npmRegistryServer` still
# reports the approved feed.
#
# Measured with Yarn 4.14.1. Two behaviours make this fail open rather than merely unchecked:
#   - a scope pointing elsewhere is used verbatim: with `npmScopes.types.npmRegistryServer` set to a
#     bogus host, `yarn npm info @types/node` failed DNS while unscoped `typescript` resolved fine;
#   - a scope that declares NO registry does not inherit the configured top-level. It falls back to
#     Yarn's built-in `https://registry.yarnpkg.com`, and YARN_NPM_REGISTRY_SERVER does not override
#     it. With the top level pointed at a bogus host, `yarn npm info @types/node` still SUCCEEDED
#     while unscoped `typescript` failed. So merely naming a scope is enough to leave the feed.
#
# There is no environment variable that resets the whole map, so this fails closed instead of
# repointing. `yarn config get npmScopes --json` prints one JSON object keyed by scope name (without
# the leading '@'), or the bare word `undefined` when no scope is configured:
#   {"types":{"npmAlwaysAuth":false,...,"npmRegistryServer":"https://scoped.example.invalid/"}}
check_yarn_scoped_registries() {
    local failed=0
    local scopes scope reported

    if ! scopes="$(config_in_neutral_directory_strict yarn config get npmScopes --json)"; then
        echo "  ❌ 'yarn config get npmScopes --json' failed; refusing to install rather than assume no scoped registries are configured"
        return 1
    fi

    # Only the literal `undefined` means "no scopes are configured" - that is what Yarn 4.14.1
    # prints for an unset map. An empty read is not the same thing: it means the query answered
    # nothing at all, which is the renamed-setting case, so it fails closed with everything else
    # that does not parse as JSON.
    if [ "$scopes" = "undefined" ]; then
        echo "  ✅ yarn declares no scoped registries"
        return 0
    fi

    if [ -z "$scopes" ]; then
        echo "  ❌ 'yarn config get npmScopes --json' returned nothing; refusing to install rather than assume no scoped registries are configured"
        return 1
    fi

    while IFS=$'\t' read -r scope reported; do
        if [ "$scope" = "__PARSE_FAILED__" ]; then
            echo "  ❌ could not read yarn's npmScopes configuration; refusing to install rather than assume it is empty"
            return 1
        fi

        if [ "${reported%/}" != "${APPROVED_NPM_REGISTRY%/}" ]; then
            echo "  ❌ yarn resolves @$scope packages from '$reported' instead of the approved feed '$APPROVED_NPM_REGISTRY'"
            failed=1
        else
            echo "  ✅ yarn @$scope -> $reported"
        fi
    done < <(printf '%s' "$scopes" | node -e '
        let raw = "";
        process.stdin.on("data", chunk => raw += chunk);
        process.stdin.on("end", () => {
            try {
                const scopes = JSON.parse(raw);
                for (const [scope, settings] of Object.entries(scopes ?? {})) {
                    // A null npmRegistryServer cannot be reported as "inherits the approved feed":
                    // Yarn substitutes its own public default for it, so report it as the public
                    // registry it actually resolves from.
                    process.stdout.write(scope + "\t" + (settings?.npmRegistryServer ?? "https://registry.yarnpkg.com") + "\n");
                }
            }
            catch {
                process.stdout.write("__PARSE_FAILED__\t\n");
            }
        });
    ')

    return "$failed"
}

# Bun has no config-read command, so unlike the managers above it cannot be asked what it resolved.
# XDG_CONFIG_HOME moves bun's config home off $HOME, but a bun that stopped honouring XDG would fall
# back there silently and pick a scoped registry back up. Read the files bun would fall back to and
# fail closed on any registry key in them that is not the approved feed, so that drift is loud here
# instead of invisible until a package arrives from the wrong host.
#
# $HOME/.npmrc uses npm syntax:
#   @types:registry=https://scoped.example.invalid/
# $HOME/.bunfig.toml uses TOML, where a scope key is the bare scope name with no leading '@' and a
# value may be a basic (double-quoted) or literal (single-quoted) string:
#   [install]
#   registry = "https://scoped.example.invalid/"
#   [install.scopes]
#   "types" = "https://scoped.example.invalid/"
#   types = 'https://scoped.example.invalid/'
#
# Rather than model either grammar, strip comments and then flag every URL that remains, which is
# what NpmLockfileRegistryTests.FindRegistryOverrides does for the fixture-side copies of these same
# files. A key-anchored, end-of-line-anchored match missed a literal string and any value carrying a
# trailing comment - both legal, and both silently reported as "no ambient registry override".
# Comments start with '#' in both formats and '.npmrc' also accepts ';'; a registry URL has no
# fragment, so cutting at a '#' that begins a line or follows whitespace cannot truncate a real
# value. The two sed expressions are separate because BSD sed has no BRE alternation.
#
# Only values that are themselves URLs are considered, which skips npm auth lines such as
# `//pkgs.dev.azure.com/...:_authToken=<token>`: the key is protocol-relative, so it carries no
# scheme to match, and the value is a token rather than a URL.
check_bun_ambient_config() {
    local failed=0
    local file value
    local url_pattern="https?://[^]\"'[:space:],}]*"

    for file in "$HOME/.npmrc" "$HOME/.bunfig.toml"; do
        [ -f "$file" ] || continue

        while IFS= read -r value; do
            if [ "${value%/}" != "${APPROVED_NPM_REGISTRY%/}" ]; then
                echo "  ❌ bun falls back to '$file', which points a registry at '$value' instead of the approved feed '$APPROVED_NPM_REGISTRY'"
                failed=1
            fi
        done < <(sed -e 's|^[#;].*$||' -e 's|[[:space:]][#;].*$||' "$file" | grep -Eo "$url_pattern" || true)
    done

    if [ "$failed" -eq 0 ]; then
        echo "  ✅ bun has no ambient registry override outside $XDG_CONFIG_HOME"
    fi

    return "$failed"
}

verify_registry_configuration() {
    local failed=0
    local yarn_version

    echo "Package registry configuration:"

    if command -v npm &> /dev/null; then
        check_manager_registry "npm" "$(config_in_neutral_directory npm config get registry)" || failed=1
        check_scoped_registries || failed=1
    fi

    if command -v bun &> /dev/null; then
        check_bun_ambient_config || failed=1
    fi

    if command -v pnpm &> /dev/null; then
        check_manager_registry "pnpm" "$(config_in_neutral_directory pnpm config get registry)" || failed=1
    fi

    if command -v yarn &> /dev/null; then
        # Yarn Classic does not understand npmRegistryServer and prints "undefined" for it, while
        # still exiting 0. It also ignores npm_config_registry, so there is no way to point it at the
        # approved feed from the environment. A Classic binary on PATH would still be used to install
        # a Berry AppHost, so surface it here instead of letting it reach the public registry.
        #
        # The version query has to run in the same neutral directory as the config query, because
        # which yarn answers depends on the working directory: the launcher honours the nearest
        # package.json "packageManager" field, so from a fixture pinned to yarn@4.14.1 `yarn
        # --version` reports 4.14.1 while the same command one directory up reports the globally
        # installed 1.22.22. Asking in two different directories lets a Classic binary pass the
        # version gate and then answer "undefined" to the config query, which reports a registry
        # mismatch when the real problem is the yarn version.
        yarn_version="$(config_in_neutral_directory yarn --version)"

        if [[ "$yarn_version" == 1.* ]]; then
            echo "  ❌ yarn is Yarn Classic ($yarn_version), which cannot be pointed at the approved feed. Install Yarn 4 or later."
            failed=1
        else
            check_manager_registry "yarn" "$(config_in_neutral_directory yarn config get npmRegistryServer)" || failed=1
            check_yarn_scoped_registries || failed=1
        fi
    fi

    if [ "$failed" -ne 0 ]; then
        echo "❌ Refusing to install: packages would be downloaded from outside the approved feed."
        exit 1
    fi
}

verify_registry_configuration

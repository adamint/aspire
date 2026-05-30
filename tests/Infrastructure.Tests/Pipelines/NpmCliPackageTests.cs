// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Xunit;

namespace Infrastructure.Tests;

public sealed class NpmCliPackageTests
{
    private readonly string _repoRoot = FindRepoRoot();

    [Fact]
    public async Task LauncherDetectsMuslArm64AndThrowsUnsupported()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // libc-mismatched binaries crash at exec with cryptic dynamic-linker
        // errors. Previously the launcher only checked musl for x64 and silently
        // fell through to the glibc-linked `linux-arm64` binary on Alpine arm64.
        // Assert the musl-arm64 case throws a friendly "Unsupported platform"
        // error rather than silently resolving to a binary that will crash.
        Assert.Contains("if (arch === 'arm64' && musl)", launcher);
        Assert.Contains("Unsupported platform: ${platform} musl ${arch}", launcher);
    }

    [Fact]
    public async Task LauncherRejectsNonRegularCachedBinary()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // The native binary is copied from the (signed) node_modules source into
        // a writable cache before exec. `needsCopy` previously trusted any cache
        // entry that matched the source size/mtime, so a same-user process could
        // swap the cache entry for a symlink to attacker content and the launcher
        // would exec it. Verify the staleness check lstat's the target and only
        // trusts regular files, forcing a fresh copy otherwise.
        Assert.Contains("const target = fs.lstatSync(targetPath);", launcher);
        Assert.Contains("if (!target.isFile()) {", launcher);
    }

    [Fact]
    public async Task LauncherForwardsTerminatingSignalsToChild()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // Programmatic `kill <wrapper-pid>` was orphaning the native CLI because
        // the launcher only handled child exit and never forwarded inbound
        // signals to the child. Especially bad for `aspire run` which keeps an
        // AppHost alive. Verify termination signals are wired up and that we use
        // `once` so a second signal can still kill the wrapper if the child
        // ignores the first.
        Assert.Contains("process.once(signal", launcher);
        Assert.Contains("child.kill(signal)", launcher);
    }

    [Fact]
    public async Task LauncherUsesPlatformSpecificSignalListToAvoidWindowsCrash()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // SIGQUIT is POSIX-only: on Windows `process.once('SIGQUIT', ...)` throws
        // `uv_signal_start EINVAL`, which (because the child is already spawned)
        // would crash the launcher and orphan the running CLI on every Windows
        // invocation. Verify the signal list is built per platform so SIGQUIT is
        // never registered on Windows, and that each registration is guarded so an
        // unexpected platform/libuv mismatch can never crash the launcher.
        Assert.Contains("process.platform === 'win32'", launcher);
        Assert.Contains("? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']", launcher);
        Assert.Contains(": ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']", launcher);
    }

    [Fact]
    public async Task LauncherRegistersSignalHandlersBeforeSpawningChild()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // A signal delivered in the window between spawn and handler registration
        // could terminate the wrapper and orphan the child - the exact failure the
        // forwarding is meant to prevent. Verify `child` is declared before the
        // signal loop and assigned by `childProcess.spawn` afterwards.
        var declarationIndex = launcher.IndexOf("let child;", System.StringComparison.Ordinal);
        var spawnIndex = launcher.IndexOf("child = childProcess.spawn(", System.StringComparison.Ordinal);
        Assert.True(declarationIndex >= 0, "Expected `let child;` declaration in launcher.");
        Assert.True(spawnIndex >= 0, "Expected `child = childProcess.spawn(` assignment in launcher.");
        Assert.True(declarationIndex < spawnIndex, "Signal handlers must be registered before the child is spawned.");
    }

    [Fact]
    public async Task LauncherDetectsMuslViaFilesystemFallbackWhenLddMissing()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // On minimal Alpine images `ldd` can be absent, in which case the old code
        // wrongly assumed glibc and resolved a binary whose dynamic linker is
        // missing (crashing at exec). Verify the launcher falls back to probing
        // for the musl dynamic linker (/lib/ld-musl-*.so) when ldd gives no
        // recognizable banner.
        Assert.Contains("ld-musl-", launcher);
        Assert.Contains("readdirSync", launcher);
    }

    [Fact]
    public async Task LauncherCreatesCacheDirectoryOwnerOnly()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // The native binary cache may land in a shared location (an
        // ASPIRE_NPM_CACHE_DIR override, or the os.tmpdir() fallback when no home
        // directory is available). Create it owner-only so another local user
        // cannot pre-create or read the cached executable.
        Assert.Contains("recursive: true, mode: 0o700", launcher);
    }

    [Fact]
    public async Task LauncherLoadsRidPackageMapInsideErrorHandler()
    {
        var launcher = await ReadRepoFileAsync("eng/clipack/npm/aspire.js");

        // A missing/corrupt aspire-package-map.json used to throw raw
        // ENOENT/SyntaxError with a Node stack at module load — bypassing the
        // launcher's top-level try/catch that produces friendly errors. Verify
        // the map is loaded lazily inside main() and that read/parse failures
        // produce a "corrupted ... Reinstall" message rather than a stack.
        Assert.Contains("if (ridPackageNames === null)", launcher);
        Assert.Contains("ridPackageNames = loadRidPackageNames()", launcher);
        Assert.Contains("Aspire CLI installation is corrupted", launcher);
        Assert.Contains("Reinstall @microsoft/aspire-cli", launcher);
    }

    [Fact]
    public async Task PackScriptUsesLiteralHereStringForRidReadme()
    {
        var packScript = await ReadRepoFileAsync("eng/scripts/pack-cli-npm-package.ps1");

        // Previously the RID-package README used an expandable here-string with
        // `$Rid` and `$PackageName`. In PowerShell expandable here-strings the
        // backtick is the escape character, so the markdown code-span backticks
        // were both stripped AND the $-interpolation was suppressed. Result:
        // shipped READMEs read `Native Aspire CLI binary for $Rid.` with no
        // backticks. Verify the script now uses a literal here-string (@'...'@)
        // with explicit -replace placeholders so backticks survive verbatim.
        Assert.Contains("$ridReadmeTemplate = @'", packScript);
        Assert.Contains("Native Aspire CLI binary for `__RID__`.", packScript);
        Assert.Contains("This package is installed as an optional dependency of `__PACKAGE_NAME__`.", packScript);
        Assert.Contains("-replace '__RID__', $Rid", packScript);
        Assert.Contains("-replace '__PACKAGE_NAME__', $PackageName", packScript);

        // The original broken sequence (expandable here-string with `$Rid`) must
        // not be reintroduced.
        Assert.DoesNotContain("Native Aspire CLI binary for `$Rid`.", packScript);
    }

    [Fact]
    public async Task PointerPackageRequiresNode20OrLater()
    {
        var packScript = await ReadRepoFileAsync("eng/scripts/pack-cli-npm-package.ps1");

        // The launcher (`bin/aspire.js`) uses the Error options-bag
        // `new Error(msg, { cause: err })` which was added in Node 16.9.0.
        // Node 16.0–16.8.x would throw `TypeError: Unknown option 'cause'`
        // at module load before the friendly "Aspire CLI installation is
        // corrupted" message could be printed.
        // The per-RID `libc` selector in optionalDependencies relies on
        // npm >= 10.7 which ships with Node 20.10+. Node 18 reaches end
        // of life on 2025-04-30, so Node 20 is the lowest LTS we should
        // pin at GA. See https://nodejs.org/en/about/previous-releases.
        // Guard against accidental regression to `>=16` (or any earlier
        // version) which would let the launcher crash on supported Node
        // engines.
        Assert.Contains("node = '>=20'", packScript);
        Assert.DoesNotContain("node = '>=16'", packScript);
        Assert.DoesNotContain("node = '>=18'", packScript);
    }

    private Task<string> ReadRepoFileAsync(string relativePath)
        => File.ReadAllTextAsync(Path.Combine(_repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));

    private static string FindRepoRoot()
    {
        string? current = AppContext.BaseDirectory;

        while (current is not null)
        {
            if (File.Exists(Path.Combine(current, "Aspire.slnx")))
            {
                return current;
            }

            current = Directory.GetParent(current)?.FullName;
        }

        throw new DirectoryNotFoundException("Could not find repository root containing Aspire.slnx");
    }
}

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using Aspire.Cli.Backchannel;
using Aspire.Cli.Interaction;

namespace Aspire.Cli.Utils;

internal class ExtensionHelper
{
    public static bool IsExtensionHost(
        IInteractionService interactionService,
        [NotNullWhen(true)] out IExtensionInteractionService? extensionInteractionService,
        [NotNullWhen(true)] out IExtensionBackchannel? extensionBackchannel)
    {
        if (interactionService is IExtensionInteractionService eis)
        {
            extensionInteractionService = eis;
            extensionBackchannel = eis.Backchannel;
            return true;
        }

        extensionInteractionService = null;
        extensionBackchannel = null;
        return false;
    }
}

internal static class KnownCapabilities
{
    public const string DevKit = "devkit";
    public const string Project = "project";
    public const string Node = "node";

    // AppHost build ownership. Whichever side advertises this capability promises the AppHost is
    // built exactly once before launch, so the other side skips its own build.
    //
    // The unversioned predecessor ("build-dotnet-using-cli", CLI 13.2.0-13.2.4) could not be
    // trusted: on those CLI versions a no-debug launch from the extension forced watch mode, which
    // skipped the CLI pre-build entirely even though the CLI still advertised the token. An
    // extension that believed the token skipped its own build too, so nobody built and the user
    // silently launched stale output (https://github.com/microsoft/aspire/issues/15850).
    // The version suffix makes the promise verifiable, so build ownership only transfers when both
    // sides understand the newer contract. Never accept the unversioned token here.
    public const string BuildDotnetUsingCliV2 = "build-dotnet-using-cli.v2";
    public const string Baseline = "baseline.v1";
    public const string SecretPrompts = "secret-prompts.v1";
    public const string FilePickers = "file-pickers.v1";
    public const string Pipelines = "pipelines";

    // Advertised so tooling (e.g. the VS Code extension) can detect that `aspire describe`
    // understands the hidden `--include-disabled-commands` flag without having to optimistically
    // pass it and parse (localized) error output when an older CLI rejects it.
    public const string DescribeIncludeDisabledCommands = "describe-include-disabled-commands.v1";

    // Advertised so tooling can detect that `aspire ls --format json --stream` is supported
    // before opting into newline-delimited JSON candidate discovery.
    public const string LsJsonStream = "ls-json-stream.v1";

    /// <summary>
    /// Gets the set of capabilities this CLI advertises to extensions.
    /// </summary>
    public static string[] GetAdvertisedCapabilities() => [DevKit, Project, BuildDotnetUsingCliV2, Baseline, SecretPrompts, FilePickers, Pipelines, DescribeIncludeDisabledCommands, LsJsonStream];
}

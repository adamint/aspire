// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.CommandLine;
using System.Text.Json;
using Aspire.Cli.Configuration;
using Aspire.Cli.Interaction;
using Aspire.Cli.Projects;
using Microsoft.Extensions.Logging;
using StreamJsonRpc;

namespace Aspire.Cli.Commands.Sdk;

/// <summary>
/// Command for exporting the canonical API reference of an Aspire package for a target language.
///
/// Usage:
///   aspire sdk export --language typescript                                     # Core Aspire.Hosting at this CLI's SDK version
///   aspire sdk export --language typescript --package Aspire.Hosting.Redis@13.5.0
/// </summary>
/// <remarks>
/// The output is consumed by documentation pipelines, so stdout carries exactly one JSON document
/// and nothing else. Every status message, warning, and error goes to stderr, which is what makes
/// <c>aspire sdk export ... &gt; api.json</c> produce a usable file.
/// </remarks>
internal sealed class SdkExportCommand : BaseCommand
{
    private const string CorePackageName = "Aspire.Hosting";

    private readonly IAppHostServerProjectFactory _appHostServerProjectFactory;
    private readonly IAppHostServerSessionFactory _serverSessionFactory;
    private readonly ILanguageDiscovery _languageDiscovery;
    private readonly ILogger<SdkExportCommand> _logger;

    private static readonly Option<string> s_languageOption = new("--language", "-l")
    {
        Description = "Target language for the API export (e.g., typescript).",
        Required = true
    };
    private static readonly Option<string?> s_packageOption = new("--package", "-p")
    {
        Description = "Package to export in PackageName@Version format. Defaults to the core Aspire.Hosting package at this CLI's SDK version."
    };
    private static readonly Option<string?> s_sourceOption = new("--source", "-s")
    {
        Description = "NuGet package source to restore the package from."
    };
    private static readonly Option<FileInfo?> s_outputOption = new("--output", "-o")
    {
        Description = "Output file. If not specified, the document is written to stdout."
    };

    public SdkExportCommand(
        IAppHostServerProjectFactory appHostServerProjectFactory,
        IAppHostServerSessionFactory serverSessionFactory,
        ILanguageDiscovery languageDiscovery,
        ILogger<SdkExportCommand> logger,
        CommonCommandServices services)
        : base("export", "Export the canonical API reference for an Aspire package in a target language.", services)
    {
        _appHostServerProjectFactory = appHostServerProjectFactory;
        _serverSessionFactory = serverSessionFactory;
        _languageDiscovery = languageDiscovery;
        _logger = logger;

        // Not marked Hidden: the parent `sdk` command already hides the whole subtree, and setting
        // Hidden here additionally suppresses this command's own --help output.
        Options.Add(s_languageOption);
        Options.Add(s_packageOption);
        Options.Add(s_sourceOption);
        Options.Add(s_outputOption);
    }

    protected override async Task<CommandResult> ExecuteAsync(ParseResult parseResult, CancellationToken cancellationToken)
    {
        // This command always emits machine-readable JSON, so it has no --format option for
        // BaseCommand's json redirect to key off. Without this, preparation diagnostics and the
        // --output success message land on stdout and corrupt the document a caller is piping.
        // The JSON write overrides back to stdout explicitly, and an explicit override wins.
        InteractionService.Console = ConsoleOutput.Error;

        var language = parseResult.GetValue(s_languageOption)!;
        var package = parseResult.GetValue(s_packageOption);
        var packageSource = parseResult.GetValue(s_sourceOption);
        var outputFile = parseResult.GetValue(s_outputOption);

        string packageName;
        string packageVersion;
        var integrations = new List<IntegrationReference>();

        if (string.IsNullOrWhiteSpace(package))
        {
            // Documentation has to describe the SDK this CLI generates against, so the default is
            // the CLI's own identity version rather than whatever the feed currently calls latest.
            packageName = CorePackageName;
            packageVersion = ExecutionContext.IdentityVersion;
        }
        else
        {
            if (!SdkCommandPreparation.TryParseIntegrationArgument(
                    package,
                    requireExactVersion: true,
                    out var reference,
                    out var errorExitCode,
                    out var errorMessage))
            {
                return CommandResult.Failure(errorExitCode, errorMessage!);
            }

            if (reference!.Version is null)
            {
                return CommandResult.Failure(
                    CliExitCodes.InvalidCommand,
                    $"Invalid package '{package}'. Expected PackageName@Version (e.g. Aspire.Hosting.Redis@13.5.0); project references are not supported by sdk export.");
            }

            packageName = reference.Name;
            packageVersion = reference.Version;

            // The core package is always restored by the scanner AppHost, so adding it again would
            // produce a duplicate package reference.
            if (string.Equals(packageName, CorePackageName, StringComparison.OrdinalIgnoreCase))
            {
                // The scanner loads the core assemblies this CLI was built against, so a different
                // requested version would be exported as this CLI's surface under someone else's
                // version number. That is the same stale-signature problem this command exists to
                // fix, so refuse instead of labelling the export with a version it does not describe.
                var requested = StripBuildMetadata(packageVersion);
                if (!string.Equals(requested, ExecutionContext.IdentitySdkVersion, StringComparison.OrdinalIgnoreCase))
                {
                    return CommandResult.Failure(
                        CliExitCodes.InvalidCommand,
                        $"This CLI can only export {CorePackageName}@{ExecutionContext.IdentitySdkVersion}, but {packageVersion} was requested. " +
                        $"The scanner loads the core assemblies this CLI ships with, so exporting a different version would describe the wrong API surface. " +
                        $"Run the export with the {requested} CLI instead.");
                }
            }
            else
            {
                // Pin the requested version: a bare NuGet version is a minimum, so an unavailable
                // version would restore as a later one and be published under the wrong number.
                integrations.Add(IntegrationReference.FromExactPackage(reference.Name, reference.Version));
            }
        }

        // The code generator lives in a separate package that the scanner AppHost does not reference
        // by default, so without this the server loads no generators and every export fails with
        // "No code generator found". `sdk generate` adds the same package for the same reason.
        var codeGenPackage = await GetCodeGenerationPackageAsync(language, cancellationToken);
        if (codeGenPackage is not null)
        {
            integrations.Add(IntegrationReference.FromPackage(codeGenPackage, ExecutionContext.IdentityVersion));
        }

        return CommandResult.FromExitCode(await ExportApiAsync(
            language,
            packageName,
            packageVersion,
            integrations,
            packageSource,
            outputFile,
            cancellationToken));
    }

    /// <summary>
    /// Resolves the code generation package that provides the requested language, matching the way
    /// <c>sdk generate</c> resolves it. Returns <see langword="null"/> when the language is unknown so
    /// that the server produces the authoritative unsupported-language error.
    /// </summary>
    private async Task<string?> GetCodeGenerationPackageAsync(string language, CancellationToken cancellationToken)
    {
        try
        {
            var languages = await _languageDiscovery.GetAvailableLanguagesAsync(cancellationToken);

            var languageInfo = languages.FirstOrDefault(l =>
                l.LanguageId.Value.StartsWith(language, StringComparison.OrdinalIgnoreCase) ||
                l.CodeGenerator.Equals(language, StringComparison.OrdinalIgnoreCase));

            if (languageInfo is null)
            {
                return null;
            }

            return await _languageDiscovery.GetPackageForLanguageAsync(languageInfo.LanguageId, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Failed to resolve the code generation package for language {Language}", language);
            return null;
        }
    }

    /// <summary>
    /// Drops SemVer build metadata so <c>13.5.0+abc123</c> and <c>13.5.0</c> compare equal, matching
    /// how <see cref="CliExecutionContext.IdentitySdkVersion"/> normalizes this CLI's own version.
    /// </summary>
    private static string StripBuildMetadata(string version)
    {
        var plusIndex = version.IndexOf('+', StringComparison.Ordinal);
        return plusIndex < 0 ? version : version[..plusIndex];
    }

    /// <summary>
    /// Refuses an export the scanner would satisfy from a local checkout instead of restoring the
    /// requested package version.
    /// </summary>
    /// <remarks>
    /// In repository development mode the scanner AppHost replaces every first-party
    /// <c>Aspire.Hosting.*</c> package reference with the matching project under <c>src/</c> and
    /// discards the requested version, so the checkout's API surface would be published under
    /// someone else's version number. That is the same stale-signature problem the core-package
    /// guard prevents, so this refuses for the same reason. Asking for the version this CLI was
    /// built from is still allowed: that is exactly what the checkout contains. The core package is
    /// already handled before any project is created, and third-party packages are never
    /// substituted, so both fall straight through.
    /// </remarks>
    /// <param name="serverProject">The scanner AppHost that will restore the export.</param>
    /// <param name="packageName">The package being exported.</param>
    /// <param name="packageVersion">The version the caller asked for.</param>
    /// <returns>The rejection reason, or <see langword="null"/> when the request is exportable.</returns>
    private string? ValidateRequestedPackageIsRestorable(IAppHostServerProject serverProject, string packageName, string packageVersion)
    {
        if (string.Equals(packageName, CorePackageName, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (serverProject.GetLocalProjectSubstitution(packageName) is not string localProjectPath)
        {
            return null;
        }

        var requested = StripBuildMetadata(packageVersion);
        if (string.Equals(requested, ExecutionContext.IdentitySdkVersion, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return $"This CLI runs from an Aspire repository checkout, so {packageName} is built from {localProjectPath} " +
               $"instead of being restored from a package feed. That checkout is {ExecutionContext.IdentitySdkVersion}, " +
               $"but {packageVersion} was requested, and exporting it would describe the checkout's API surface under the " +
               $"requested version. Run the export with the {requested} CLI, or request {packageName}@{ExecutionContext.IdentitySdkVersion}.";
    }

    private async Task<int> ExportApiAsync(
        string language,
        string packageName,
        string packageVersion,
        List<IntegrationReference> integrations,
        string? packageSource,
        FileInfo? outputFile,
        CancellationToken cancellationToken)
    {
        // The AppHost is restored at the version being documented so the export describes that exact
        // SDK, not the CLI's bundled one.
        var sdkVersion = string.Equals(packageName, CorePackageName, StringComparison.OrdinalIgnoreCase)
            ? packageVersion
            : ExecutionContext.IdentityVersion;

        string? rejection = null;

        await using var session = await SdkCommandPreparation.PrepareSessionAsync(
            _appHostServerProjectFactory,
            _serverSessionFactory,
            InteractionService,
            _logger,
            "aspire-sdk-export-",
            sdkVersion,
            integrations,
            packageSource,
            validateProject: serverProject => rejection = ValidateRequestedPackageIsRestorable(serverProject, packageName, packageVersion),
            cancellationToken);

        if (session is null)
        {
            // A rejection is a usage error the caller fixes by asking for a different version or
            // running a different CLI, so it must not look like the scanner failed to build.
            return rejection is not null
                ? CliExitCodes.InvalidCommand
                : CliExitCodes.FailedToBuildArtifacts;
        }

        JsonElement export;
        try
        {
            _logger.LogDebug("Exporting {Language} API reference for {PackageName}@{PackageVersion} via RPC", language, packageName, packageVersion);
            export = await session.RpcClient.ExportApiAsync(language, packageName, packageVersion, cancellationToken);
        }
        catch (RemoteInvocationException ex)
        {
            InteractionService.DisplayError(ex.Message);

            // An unsupported language is a usage error the caller can fix by choosing another
            // language, so it is worth distinguishing from the AppHost genuinely falling over.
            return IsUnsupportedLanguage(ex)
                ? CliExitCodes.InvalidCommand
                : CliExitCodes.FailedToBuildArtifacts;
        }
        catch (NotSupportedException ex)
        {
            InteractionService.DisplayError(ex.Message);
            return CliExitCodes.InvalidCommand;
        }

        // GetRawText is the document exactly as the language provider wrote it. Re-serializing would
        // reshape whitespace and property order for no benefit, and the whole contract here is that
        // the payload passes through untouched.
        var json = export.GetRawText();

        if (outputFile is not null)
        {
            var outputDir = outputFile.Directory;
            if (outputDir is not null && !outputDir.Exists)
            {
                outputDir.Create();
            }

            await File.WriteAllTextAsync(outputFile.FullName, json, cancellationToken);
            InteractionService.DisplaySuccess($"API reference written to {outputFile.FullName}");
            return CliExitCodes.Success;
        }

        InteractionService.DisplayRawText(json, consoleOverride: ConsoleOutput.Standard);
        return CliExitCodes.Success;
    }

    // RemoteHost raises NotSupportedException for a generator that cannot export; StreamJsonRpc
    // flattens that to a message string, so the type name is the only marker that survives the wire.
    private static bool IsUnsupportedLanguage(RemoteInvocationException ex)
        => ex.Message.Contains("IApiReferenceExporter", StringComparison.Ordinal)
           || ex.Message.Contains("No code generator found for language", StringComparison.Ordinal);
}

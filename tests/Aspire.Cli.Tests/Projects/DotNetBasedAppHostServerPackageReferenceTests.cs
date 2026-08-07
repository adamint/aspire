// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using System.IO.Compression;
using System.Xml.Linq;
using Aspire.Cli.Configuration;
using Aspire.Cli.Projects;
using Aspire.Cli.Tests.Mcp;
using Aspire.Cli.Tests.TestServices;
using Aspire.Cli.Tests.Utils;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Cli.Tests.Projects;

/// <summary>
/// The generated capability scanner writes its own <c>Directory.Packages.props</c> that turns central
/// package management on so transitive dependencies pick up the repo's pinned versions. Central package
/// management rejects an inline <c>Version</c> attribute on a <c>PackageReference</c> with NU1008, which
/// made the scanner fail to build for any integration that lives outside the repo — the exact case
/// <c>aspire sdk export</c> hits when it is pointed at a third-party package such as a Community Toolkit
/// integration.
/// </summary>
public class DotNetBasedAppHostServerPackageReferenceTests(ITestOutputHelper outputHelper)
{
    [Fact]
    public async Task CreateProjectFiles_PinsOutOfRepoIntegrationsWithVersionOverride()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appPath = workspace.WorkspaceRoot.FullName;
        var projectModelPath = Path.Combine(appPath, ".aspire_server");

        var project = CreateProject(appPath, projectModelPath);

        // There is no src/CommunityToolkit.Aspire.Hosting.ActiveMQ under the fake repo root, so this
        // integration takes the package path rather than the project-reference path.
        await project.CreateProjectFilesAsync(
            [IntegrationReference.FromPackage("CommunityToolkit.Aspire.Hosting.ActiveMQ", "13.4.0")]);

        var packagesProps = XDocument.Load(Path.Combine(projectModelPath, "Directory.Packages.props"));
        Assert.Equal(
            "true",
            packagesProps.Descendants("ManagePackageVersionsCentrally").Single().Value);

        var reference = XDocument.Load(Path.Combine(projectModelPath, "AppHostServer.csproj"))
            .Descendants("PackageReference")
            .Single(element => element.Attribute("Include")?.Value == "CommunityToolkit.Aspire.Hosting.ActiveMQ");

        Assert.Equal("13.4.0", reference.Attribute("VersionOverride")?.Value);
        Assert.Null(reference.Attribute("Version"));
    }

    /// <summary>
    /// Asserting on the generated XML alone cannot catch a change in how NuGet treats
    /// <c>VersionOverride</c> under central package management. This restores the generated project
    /// for real against an offline folder feed, with a central package list that deliberately has no
    /// entry for the out-of-repo integration, so a regression surfaces as NU1008 or NU1010.
    /// </summary>
    [Fact]
    public async Task CreateProjectFiles_ProducesAProjectThatRestores()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appPath = workspace.WorkspaceRoot.FullName;
        var projectModelPath = Path.Combine(appPath, ".aspire_server");
        var feedPath = Path.Combine(appPath, "feed");
        Directory.CreateDirectory(feedPath);

        const string IntegrationPackage = "CommunityToolkit.Aspire.Hosting.ActiveMQ";

        // The template always references these two without a version, so they have to resolve
        // through the central list the way they do in the real repo.
        CreateStubPackage(feedPath, "StreamJsonRpc", "1.0.0");
        CreateStubPackage(feedPath, "Google.Protobuf", "1.0.0");
        CreateStubPackage(feedPath, IntegrationPackage, "13.4.0");

        // Mirrors the real repo: a central list that pins first-party dependencies but knows nothing
        // about a Community Toolkit integration.
        await File.WriteAllTextAsync(Path.Combine(appPath, "Directory.Packages.props"), """
            <Project>
              <ItemGroup>
                <PackageVersion Include="StreamJsonRpc" Version="1.0.0" />
                <PackageVersion Include="Google.Protobuf" Version="1.0.0" />
              </ItemGroup>
            </Project>
            """);

        var project = CreateProject(appPath, projectModelPath);

        await project.CreateProjectFilesAsync(
            [IntegrationReference.FromPackage(IntegrationPackage, "13.4.0")]);

        var (exitCode, output) = await RestoreAsync(
            Path.Combine(projectModelPath, "AppHostServer.csproj"),
            feedPath);

        outputHelper.WriteLine(output);

        // NU1008 is the inline Version attribute this fix replaced; NU1010 is the failure mode that
        // would appear if VersionOverride stopped satisfying the central list requirement.
        Assert.DoesNotContain("NU1008", output, StringComparison.Ordinal);
        Assert.DoesNotContain("NU1010", output, StringComparison.Ordinal);
        Assert.Equal(0, exitCode);
    }

    /// <summary>
    /// <c>aspire sdk export</c> publishes documentation keyed on the requested version, so the
    /// restore has to fail when that version is unavailable rather than resolve to a later one.
    /// </summary>
    [Fact]
    public async Task CreateProjectFiles_PinsExactIntegrationsToASingleVersionRange()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appPath = workspace.WorkspaceRoot.FullName;
        var projectModelPath = Path.Combine(appPath, ".aspire_server");

        var project = CreateProject(appPath, projectModelPath);

        await project.CreateProjectFilesAsync(
        [
            IntegrationReference.FromExactPackage("CommunityToolkit.Aspire.Hosting.ActiveMQ", "13.4.0"),
            IntegrationReference.FromPackage("CommunityToolkit.Aspire.Hosting.Dapr", "13.4.0")
        ]);

        var references = XDocument.Load(Path.Combine(projectModelPath, "AppHostServer.csproj"))
            .Descendants("PackageReference")
            .ToDictionary(element => element.Attribute("Include")!.Value, element => element.Attribute("VersionOverride")?.Value);

        Assert.Equal("[13.4.0]", references["CommunityToolkit.Aspire.Hosting.ActiveMQ"]);

        // Everything else keeps the minimum-version form the run and dump paths have always used.
        Assert.Equal("13.4.0", references["CommunityToolkit.Aspire.Hosting.Dapr"]);
    }

    /// <summary>
    /// The generated scanner replaces a first-party <c>Aspire.Hosting.*</c> package reference with the
    /// matching repository project and drops the requested version, so a caller that publishes
    /// artifacts keyed on that version has to be able to see the substitution coming.
    /// </summary>
    [Fact]
    public void GetLocalProjectSubstitution_ReportsOnlyFirstPartyProjectsThatExist()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appPath = workspace.WorkspaceRoot.FullName;

        var redisProjectPath = Path.Combine(appPath, "src", "Aspire.Hosting.Redis", "Aspire.Hosting.Redis.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(redisProjectPath)!);
        File.WriteAllText(redisProjectPath, "<Project />");

        var project = CreateProject(appPath, Path.Combine(appPath, ".aspire_server"));

        Assert.Equal(redisProjectPath, project.GetLocalProjectSubstitution("Aspire.Hosting.Redis"));

        // No src/Aspire.Hosting.Qdrant in this checkout, so the package really is restored.
        Assert.Null(project.GetLocalProjectSubstitution("Aspire.Hosting.Qdrant"));

        // Third-party integrations are never substituted, even when a same-named folder exists.
        Assert.Null(project.GetLocalProjectSubstitution("CommunityToolkit.Aspire.Hosting.ActiveMQ"));
    }

    /// <summary>
    /// The generated XML cannot show what NuGet does with it. This restores twice against an offline
    /// feed that holds 13.4.1 but not the requested 13.4.0: the plain reference silently resolves
    /// upward (which is what mislabels an export), and the exact reference fails instead.
    /// </summary>
    [Fact]
    public async Task CreateProjectFiles_ExactIntegrationDoesNotFloatToALaterPackage()
    {
        using var workspace = TemporaryWorkspace.CreateForCli(outputHelper);
        var appPath = workspace.WorkspaceRoot.FullName;
        var feedPath = Path.Combine(appPath, "feed");
        Directory.CreateDirectory(feedPath);

        const string IntegrationPackage = "Contoso.Aspire.Hosting.ExactVersionProbe";

        CreateStubPackage(feedPath, "StreamJsonRpc", "1.0.0");
        CreateStubPackage(feedPath, "Google.Protobuf", "1.0.0");
        CreateStubPackage(feedPath, IntegrationPackage, "13.4.1");

        await File.WriteAllTextAsync(Path.Combine(appPath, "Directory.Packages.props"), """
            <Project>
              <ItemGroup>
                <PackageVersion Include="StreamJsonRpc" Version="1.0.0" />
                <PackageVersion Include="Google.Protobuf" Version="1.0.0" />
              </ItemGroup>
            </Project>
            """);

        var floatingModelPath = Path.Combine(appPath, ".aspire_server_floating");
        await CreateProject(appPath, floatingModelPath)
            .CreateProjectFilesAsync([IntegrationReference.FromPackage(IntegrationPackage, "13.4.0")]);

        var (floatingExitCode, floatingOutput) = await RestoreAsync(
            Path.Combine(floatingModelPath, "AppHostServer.csproj"),
            feedPath);
        outputHelper.WriteLine(floatingOutput);

        // 13.4.0 is a minimum, so NuGet happily hands back 13.4.1 and warns rather than fails. The
        // assets file records what was actually resolved, which the console output does not always
        // spell out.
        Assert.Equal(0, floatingExitCode);
        Assert.Contains("NU1603", floatingOutput, StringComparison.Ordinal);
        Assert.Contains(
            $"{IntegrationPackage}/13.4.1",
            await File.ReadAllTextAsync(Path.Combine(floatingModelPath, "obj", "project.assets.json")),
            StringComparison.Ordinal);

        var exactModelPath = Path.Combine(appPath, ".aspire_server_exact");
        await CreateProject(appPath, exactModelPath)
            .CreateProjectFilesAsync([IntegrationReference.FromExactPackage(IntegrationPackage, "13.4.0")]);

        var (exactExitCode, exactOutput) = await RestoreAsync(
            Path.Combine(exactModelPath, "AppHostServer.csproj"),
            feedPath);
        outputHelper.WriteLine(exactOutput);

        // NU1102 is "package found but not at the requested version", which is the failure a caller
        // needs instead of a document labelled 13.4.0 that describes 13.4.1.
        Assert.NotEqual(0, exactExitCode);
        Assert.Contains("NU1102", exactOutput, StringComparison.Ordinal);
    }

    private static DotNetBasedAppHostServerProject CreateProject(string appPath, string projectModelPath)
        => new(
            appPath,
            socketPath: "test.sock",
            repoRoot: appPath,
            new TestDotNetCliRunner(),
            MockPackagingServiceFactory.Create(),
            new TestProcessExecutionFactory(),
            new TestEnvironment(),
            NullLogger<DotNetBasedAppHostServerProject>.Instance,
            projectModelPath);

    private static void CreateStubPackage(string feedPath, string id, string version)
    {
        var stagingPath = Path.Combine(feedPath, $".staging-{id}");
        Directory.CreateDirectory(Path.Combine(stagingPath, "lib", "net10.0"));

        File.WriteAllText(Path.Combine(stagingPath, $"{id}.nuspec"), $"""
            <?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
              <metadata>
                <id>{id}</id>
                <version>{version}</version>
                <description>Stub package for restore tests.</description>
                <authors>Aspire</authors>
              </metadata>
            </package>
            """);

        File.WriteAllText(Path.Combine(stagingPath, "[Content_Types].xml"), """
            <?xml version="1.0" encoding="utf-8"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="nuspec" ContentType="text/xml" />
              <Default Extension="dll" ContentType="application/octet-stream" />
              <Default Extension="xml" ContentType="text/xml" />
            </Types>
            """);

        File.WriteAllBytes(Path.Combine(stagingPath, "lib", "net10.0", $"{id}.dll"), []);

        ZipFile.CreateFromDirectory(stagingPath, Path.Combine(feedPath, $"{id}.{version}.nupkg"));
        Directory.Delete(stagingPath, recursive: true);
    }

    private static async Task<(int ExitCode, string Output)> RestoreAsync(string projectPath, string feedPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(projectPath)!
        };

        startInfo.ArgumentList.Add("restore");
        startInfo.ArgumentList.Add(projectPath);
        // Replaces every configured source so the restore cannot reach the network.
        startInfo.ArgumentList.Add("--source");
        startInfo.ArgumentList.Add(feedPath);

        using var process = Process.Start(startInfo)!;
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        return (process.ExitCode, await stdoutTask + await stderrTask);
    }
}

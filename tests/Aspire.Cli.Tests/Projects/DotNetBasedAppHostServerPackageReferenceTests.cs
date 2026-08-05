// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

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

        var project = new DotNetBasedAppHostServerProject(
            appPath,
            socketPath: "test.sock",
            repoRoot: appPath,
            new TestDotNetCliRunner(),
            MockPackagingServiceFactory.Create(),
            new TestProcessExecutionFactory(),
            new TestEnvironment(),
            NullLogger<DotNetBasedAppHostServerProject>.Instance,
            projectModelPath);

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
}

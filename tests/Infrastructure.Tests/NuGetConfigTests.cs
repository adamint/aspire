// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Xml.Linq;

using Xunit;

namespace Infrastructure.Tests;

public sealed class NuGetConfigTests
{
    [Fact]
    public void DotNetToolsSourceIsScopedToRequiredDiagnosticsPackages()
    {
        var document = XDocument.Load(Path.Combine(RepoRoot.Path, "NuGet.config"));

        var source = Assert.Single(
            document.Root!.Element("packageSources")!.Elements("add"),
            element => (string?)element.Attribute("key") == "dotnet-tools");
        Assert.Equal(
            "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/index.json",
            (string?)source.Attribute("value"));

        var mapping = Assert.Single(
            document.Root.Element("packageSourceMapping")!.Elements("packageSource"),
            element => (string?)element.Attribute("key") == "dotnet-tools");
        var patterns = mapping.Elements("package")
            .Select(element => element.Attribute("pattern")!.Value)
            .ToArray();

        Assert.Equal(
            [
                "Microsoft.Diagnostics.NETCore.Client",
                "Microsoft.Diagnostics.Runtime",
            ],
            patterns);
    }
}

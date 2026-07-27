// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001

using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Tests.Utils;
using Microsoft.Extensions.DependencyInjection;

namespace Aspire.Hosting.Rust.Tests;

public class RustPublicApiTests
{
    [Fact]
    public void AddRustAppShouldThrowWhenBuilderIsNull()
    {
        IDistributedApplicationBuilder builder = null!;

        var action = () => builder.AddRustApp("api", "/src/rust-app");

        var exception = Assert.Throws<ArgumentNullException>(action);
        Assert.Equal(nameof(builder), exception.ParamName);
    }

    [Fact]
    public async Task AddRustAppDefaultArgsAreRunWithSeparator()
    {
        var builder = DistributedApplication.CreateBuilder();
        var app = builder.AddRustApp("api", builder.AppHostDirectory);

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal(["run", "--"], args);
    }

    [Fact]
    public async Task AddRustAppWithCargoAndAppArgsPreservesSeparatorOrdering()
    {
        var builder = DistributedApplication.CreateBuilder();
        var app = builder.AddRustApp("api", builder.AppHostDirectory)
            .WithCargoArgs("--release")
            .WithArgs("--port", "8080");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal(["run", "--release", "--", "--port", "8080"], args);
    }

    [Fact]
    public async Task WithFeatureAndBinWrappersMapToCargoArgs()
    {
        var builder = DistributedApplication.CreateBuilder();
        var app = builder.AddRustApp("api", builder.AppHostDirectory)
            .WithFeatures("tokio", "serde")
            .WithBinTarget("worker");

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);

        Assert.Equal(["run", "--features", "tokio,serde", "--bin", "worker", "--"], args);
    }

    [Fact]
    public void AddRustAppEnablesDebuggingSupport()
    {
        var builder = DistributedApplication.CreateBuilder();
        var app = builder.AddRustApp("api", builder.AppHostDirectory);

        Assert.True(app.Resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out _));
    }

    [Fact]
    public void WithCargoFetchCreatesSetupResource()
    {
        var builder = DistributedApplication.CreateBuilder();
        builder.AddRustApp("api", builder.AppHostDirectory).WithCargoFetch();
        using var app = builder.Build();
        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        Assert.Contains(model.Resources, resource => resource.Name == "api-cargo-fetch");
    }

    [Fact]
    public void WithCargoCheckCreatesSetupResource()
    {
        var builder = DistributedApplication.CreateBuilder();
        builder.AddRustApp("api", builder.AppHostDirectory).WithCargoCheck();
        using var app = builder.Build();
        var model = app.Services.GetRequiredService<DistributedApplicationModel>();

        Assert.Contains(model.Resources, resource => resource.Name == "api-cargo-check");
    }

    [Fact]
    public async Task AddBaconAppUsesBaconCommandAndRunArg()
    {
        var builder = DistributedApplication.CreateBuilder();
        var app = builder.AddBaconApp("api", builder.AppHostDirectory);

        Assert.Equal("bacon", app.Resource.Command);

        var args = await ArgumentEvaluator.GetArgumentListAsync(app.Resource);
        Assert.Equal(["run"], args);
    }
}

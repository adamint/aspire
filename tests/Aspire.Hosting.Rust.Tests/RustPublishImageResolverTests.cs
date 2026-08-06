// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Rust.Tests;

public class RustPublishImageResolverTests
{
    [Fact]
    public void DefaultsPairAMuslBuildImageWithAMuslRuntimeImage()
    {
        var images = RustPublishImageResolver.Resolve(null, null);

        Assert.Equal("rust:alpine", images.BuildImage);
        Assert.Equal("alpine:3.22", images.RuntimeImage);
    }

    [Fact]
    public void SuppliedImagesAreUsedVerbatim()
    {
        var images = RustPublishImageResolver.Resolve("rust:bookworm", "debian:bookworm-slim");

        Assert.Equal("rust:bookworm", images.BuildImage);
        Assert.Equal("debian:bookworm-slim", images.RuntimeImage);
    }
}

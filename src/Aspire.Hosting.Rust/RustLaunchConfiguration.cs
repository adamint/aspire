// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json.Serialization;
using Aspire.Hosting.Dcp.Model;

namespace Aspire.Hosting.Rust;

internal sealed class RustLaunchConfiguration() : ExecutableLaunchConfiguration("rust")
{
    [JsonPropertyName("cargo")]
    public RustCargoLaunchTarget? Cargo { get; set; }

    [JsonPropertyName("working_directory")]
    public string WorkingDirectory { get; set; } = string.Empty;
}

internal sealed class RustCargoLaunchTarget
{
    [JsonPropertyName("args")]
    public string[] Args { get; set; } = [];
}

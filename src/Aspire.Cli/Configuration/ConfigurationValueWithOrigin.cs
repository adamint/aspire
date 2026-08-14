// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Cli.Configuration;

/// <summary>
/// Represents a configuration value together with the directory relative to which local paths should be resolved.
/// </summary>
internal sealed record ConfigurationValueWithOrigin(
    string Value,
    DirectoryInfo BaseDirectory,
    bool IsGlobal = false);

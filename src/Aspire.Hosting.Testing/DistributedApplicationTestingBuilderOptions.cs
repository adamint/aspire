// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Testing;

/// <summary>
/// Provides options for creating an <see cref="IDistributedApplicationTestingBuilder"/>.
/// </summary>
/// <remarks>
/// Dashboard support is configured while the underlying distributed application builder is constructed because
/// the dashboard services cannot be added after construction. When enabled, the testing builder uses authenticated
/// HTTP endpoints on randomized loopback ports, disables interactivity, and retains the testing builder's fail-fast
/// dependency behavior. Configuration applied to the returned builder can override runtime settings such as port
/// allocation, interactivity, and dependency waiting before the application is built. Dashboard authentication is
/// selected while the underlying builder is constructed.
/// </remarks>
/// <example>
/// The following example creates a testing builder with dashboard support:
/// <code lang="csharp">
/// var options = new DistributedApplicationTestingBuilderOptions
/// {
///     EnableDashboard = true
/// };
///
/// var builder = await DistributedApplicationTestingBuilder.CreateAsync&lt;Projects.MyAppHost_AppHost&gt;(options, []);
/// </code>
/// </example>
public sealed class DistributedApplicationTestingBuilderOptions
{
    /// <summary>
    /// Gets or sets a value indicating whether the Aspire dashboard is enabled for the testing application.
    /// </summary>
    /// <value>
    /// <see langword="true"/> to enable the dashboard; otherwise, <see langword="false"/>.
    /// The default is <see langword="false"/>.
    /// </value>
    public bool EnableDashboard { get; set; }
}

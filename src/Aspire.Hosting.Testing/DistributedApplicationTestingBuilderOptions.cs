// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Testing;

/// <summary>
/// Options that control how an <see cref="IDistributedApplicationTestingBuilder"/> is created.
/// </summary>
/// <remarks>
/// These options are applied while the underlying distributed application builder is being constructed, because the
/// dashboard services themselves are selected during construction and cannot be added afterwards. The settings those
/// services read - port allocation, interactivity, and the generated browser token - remain
/// adjustable through the returned builder until the application is built.
/// </remarks>
/// <example>
/// The following example creates a testing builder that runs the dashboard:
/// <code lang="csharp">
/// var options = new DistributedApplicationTestingBuilderOptions
/// {
///     EnableDashboard = true
/// };
///
/// var builder = await DistributedApplicationTestingBuilder.CreateAsync&lt;Projects.MyAppHost_AppHost&gt;(options, []);
/// await using var app = await builder.BuildAsync();
/// await app.StartAsync();
///
/// // Open this in a browser to inspect the running application.
/// var loginUrl = await app.GetDashboardLoginUrlAsync();
/// </code>
/// </example>
public sealed class DistributedApplicationTestingBuilderOptions
{
    /// <summary>
    /// Gets or sets a value indicating whether the Aspire dashboard runs alongside the application under test.
    /// </summary>
    /// <value>
    /// <see langword="true"/> to run the dashboard; otherwise, <see langword="false"/>.
    /// The default is <see langword="false"/>.
    /// </value>
    /// <remarks>
    /// When the dashboard runs, it listens on loopback endpoints using dynamically assigned ports, so concurrent
    /// test applications do not compete for a fixed port. Loopback still means every dashboard on the machine is
    /// reachable from it; what keeps applications out of each other's dashboards is that each one generates its own
    /// browser token. Use
    /// <see cref="DistributedApplicationHostingTestingExtensions.GetDashboardLoginUrlAsync"/> to obtain an
    /// authenticated URL for the running dashboard.
    /// </remarks>
    public bool EnableDashboard { get; set; }
}

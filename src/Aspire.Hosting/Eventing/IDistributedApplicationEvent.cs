// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting.Eventing;

/// <summary>
/// Represents an event that is published during the lifecycle of the AppHost.
/// </summary>
[Experimental("ASPIREEVENTING001", UrlFormat = "https://aka.ms/dotnet/aspire/diagnostics#{0}")]
public interface IDistributedApplicationEvent
{
}

/// <summary>
/// Represents an event that is published during the lifecycle of the AppHost for a specific resource.
/// </summary>
[Experimental("ASPIREEVENTING001", UrlFormat = "https://aka.ms/dotnet/aspire/diagnostics#{0}")]
public interface IDistributedApplicationResourceEvent : IDistributedApplicationEvent
{
    /// <summary>
    /// Resource associated with this event.
    /// </summary>
    IResource Resource { get; }
}

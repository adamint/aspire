// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using Aspire.Dashboard.Components.Controls;
using Aspire.Dashboard.Extensions;
using Aspire.Dashboard.Utils;
using Google.Protobuf.WellKnownTypes;
using Humanizer;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.FluentUI.AspNetCore.Components;

namespace Aspire.Dashboard.Model;

[DebuggerDisplay("Name = {Name}, ResourceType = {ResourceType}, State = {State}, Properties = {Properties.Count}")]
public sealed class ResourceViewModel
{
    private readonly ImmutableArray<HealthReportViewModel> _healthReports = [];
    private readonly KnownResourceState? _knownState;

    public required string Name { get; init; }
    public required string ResourceType { get; init; }
    public required string DisplayName { get; init; }
    public required string Uid { get; init; }
    public required string? State { get; init; }
    public required string? StateStyle { get; init; }
    public required DateTime? CreationTimeStamp { get; init; }
    public required DateTime? StartTimeStamp { get; init; }
    public required DateTime? StopTimeStamp { get; init; }
    public required ImmutableArray<EnvironmentVariableViewModel> Environment { get; init; }
    public required ImmutableArray<UrlViewModel> Urls { get; init; }
    public required ImmutableArray<VolumeViewModel> Volumes { get; init; }
    public required ImmutableArray<RelationshipViewModel> Relationships { get; init; }
    public required ImmutableDictionary<string, ResourcePropertyViewModel> Properties { get; init; }
    public required ImmutableArray<CommandViewModel> Commands { get; init; }
    /// <summary>The health status of the resource. <see langword="null"/> indicates that health status is expected but not yet available.</summary>
    public HealthStatus? HealthStatus { get; private set; }

    public required ImmutableArray<HealthReportViewModel> HealthReports
    {
        get => _healthReports;
        init
        {
            _healthReports = value;
            HealthStatus = ComputeHealthStatus(value, KnownState);
        }
    }

    public KnownResourceState? KnownState
    {
        get => _knownState;
        init
        {
            _knownState = value;
            HealthStatus = ComputeHealthStatus(_healthReports, value);
        }
    }

    internal bool MatchesFilter(string filter)
    {
        // TODO let ResourceType define the additional data values we include in searches
        return Name.Contains(filter, StringComparisons.UserTextSearch);
    }

    public string? GetResourcePropertyValue(string propertyName)
    {
        if (Properties.TryGetValue(propertyName, out var value))
        {
            if (value.Value.TryConvertToString(out var s))
            {
                return s;
            }
        }

        return null;
    }

    internal static HealthStatus? ComputeHealthStatus(ImmutableArray<HealthReportViewModel> healthReports, KnownResourceState? state)
    {
        if (state != KnownResourceState.Running)
        {
            return null;
        }

        return healthReports.Length == 0
            // If there are no health reports and the resource is running, assume it's healthy.
            ? Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Healthy
            // If there are health reports, the health status is the minimum of the health status of the reports.
            // If any of the reports is null (first health check has not returned), the health status is unhealthy.
            : healthReports.MinBy(r => r.HealthStatus)?.HealthStatus
              ?? Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Unhealthy;
    }

    public static string GetResourceName(ResourceViewModel resource, IDictionary<string, ResourceViewModel> allResources)
    {
        var count = 0;
        foreach (var (_, item) in allResources)
        {
            if (item.IsHiddenState())
            {
                continue;
            }

            if (string.Equals(item.DisplayName, resource.DisplayName, StringComparisons.ResourceName))
            {
                count++;
                if (count >= 2)
                {
                    // There are multiple resources with the same display name so they're part of a replica set.
                    // Need to use the name which has a unique ID to tell them apart.
                    return resource.Name;
                }
            }
        }

        return resource.DisplayName;
    }
}

public sealed class ResourceViewModelNameComparer : IComparer<ResourceViewModel>
{
    public static readonly ResourceViewModelNameComparer Instance = new();

    public int Compare(ResourceViewModel? x, ResourceViewModel? y)
    {
        Debug.Assert(x != null);
        Debug.Assert(y != null);

        // Use display name by itself first.
        // This is to avoid the problem of using the full name where one resource is called "database" and another is called "database-admin".
        // The full names could end up "database-xyz" and "database-admin-xyz", which would put resources out of order.
        var displayNameResult = StringComparers.ResourceName.Compare(x.DisplayName, y.DisplayName);
        if (displayNameResult != 0)
        {
            return displayNameResult;
        }

        // Display names are the same so compare with full names.
        return StringComparers.ResourceName.Compare(x.Name, y.Name);
    }
}

[DebuggerDisplay("Name = {Name}, DisplayName = {DisplayName}")]
public sealed class CommandViewModel
{
    private sealed record IconKey(string IconName, IconVariant IconVariant);
    private static readonly ConcurrentDictionary<IconKey, CustomIcon?> s_iconCache = new();

    public string Name { get; }
    public CommandViewModelState State { get; }
    public string DisplayName { get; }
    public string DisplayDescription { get; }
    public string ConfirmationMessage { get; }
    public Value? Parameter { get; }
    public bool IsHighlighted { get; }
    public string IconName { get; }
    public IconVariant IconVariant { get; }

    public CommandViewModel(string name, CommandViewModelState state, string displayName, string displayDescription, string confirmationMessage, Value? parameter, bool isHighlighted, string iconName, IconVariant iconVariant)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);

        Name = name;
        State = state;
        DisplayName = displayName;
        DisplayDescription = displayDescription;
        ConfirmationMessage = confirmationMessage;
        Parameter = parameter;
        IsHighlighted = isHighlighted;
        IconName = iconName;
        IconVariant = iconVariant;
    }

    public static CustomIcon? ResolveIconName(string iconName, IconVariant? iconVariant)
    {
        // Icons.GetInstance isn't efficient. Cache icon lookup.
        return s_iconCache.GetOrAdd(new IconKey(iconName, iconVariant ?? IconVariant.Regular), static key =>
        {
            // We display 16px icons in the UI. Some icons aren't available in 16px size so fall back to 20px.
            CustomIcon? icon;
            if (TryGetIcon(key, IconSize.Size16, out icon))
            {
                return icon;
            }
            if (TryGetIcon(key, IconSize.Size20, out icon))
            {
                return icon;
            }

            return null;
        });
    }

    private static bool TryGetIcon(IconKey key, IconSize size, [NotNullWhen(true)] out CustomIcon? icon)
    {
        try
        {
            icon = (new IconInfo
            {
                Name = key.IconName,
                Variant = key.IconVariant,
                Size = size
            }).GetInstance();
            return true;
        }
        catch
        {
            // Icon name or size couldn't be found.
            icon = null;
            return false;
        }
    }
}

public enum CommandViewModelState
{
    Enabled,
    Disabled,
    Hidden
}

[DebuggerDisplay("Name = {Name}, Value = {Value}, FromSpec = {FromSpec}, IsValueMasked = {IsValueMasked}")]
public sealed class EnvironmentVariableViewModel : IPropertyGridItem
{
    public string Name { get; }
    public string? Value { get; }
    public bool FromSpec { get; }

    public bool IsValueMasked { get; set; } = true;

    public bool IsValueSensitive => true;

    public EnvironmentVariableViewModel(string name, string? value, bool fromSpec)
    {
        // Name should always have a value, but somehow an empty/whitespace name can reach this point.
        // Better to allow the dashboard to run with an env var with no name than break when loading resources.
        // https://github.com/dotnet/aspire/issues/5309
        Name = name;
        Value = value;
        FromSpec = fromSpec;
    }
}

[DebuggerDisplay("Name = {Name}, Value = {Value}, IsValueSensitive = {IsValueSensitive}, IsValueMasked = {IsValueMasked}")]
public sealed class ResourcePropertyViewModel : IPropertyGridItem
{
    private readonly Lazy<string> _displayValue;
    private readonly Lazy<string> _tooltip;

    public string Name { get; }
    public Value Value { get; }
    public KnownProperty? KnownProperty { get; }
    public string ToolTip => _tooltip.Value;
    public bool IsValueSensitive { get; }
    public bool IsValueMasked { get; set; }
    internal int Priority { get; }
    private readonly string _key;

    string IPropertyGridItem.Name => KnownProperty?.DisplayName ?? Name;
    string? IPropertyGridItem.Value => _displayValue.Value;

    object IPropertyGridItem.Key => _key;

    public ResourcePropertyViewModel(string name, Value value, bool isValueSensitive, KnownProperty? knownProperty, int priority, BrowserTimeProvider timeProvider)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        Name = name;
        Value = value;
        IsValueSensitive = isValueSensitive;
        KnownProperty = knownProperty;
        Priority = priority;
        IsValueMasked = isValueSensitive;

        // Known and unknown properties are displayed together. Avoid any duplicate keys.
        _key = KnownProperty != null ? KnownProperty.Key : $"unknown-{Name}";

        _tooltip = new(() => value.HasStringValue ? value.StringValue : value.ToString());

        _displayValue = new(() =>
        {
            var value = Value is { HasStringValue: true, StringValue: var stringValue }
                ? stringValue
                // Complex values such as arrays and objects will be output as JSON.
                // Consider how complex values are rendered in the future.
                : Value.ToString();

            if (Name == KnownProperties.Container.Id)
            {
                // Container images have a short ID of 12 characters
                if (value.Length > 12)
                {
                    value = value[..12];
                }
            }
            else
            {
                // Dates are returned as ISO 8601 text. Try to parse. If successful, format with the current culture.
                if (DateTime.TryParseExact(value, "o", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                {
                    value = FormatHelpers.FormatDateTime(timeProvider, date, cultureInfo: CultureInfo.CurrentCulture);
                }
            }

            return value;
        });
    }

    public bool MatchesFilter(string filter) =>
        Name.Contains(filter, StringComparison.CurrentCultureIgnoreCase) ||
        ToolTip.Contains(filter, StringComparison.CurrentCultureIgnoreCase);
}

public sealed record KnownProperty(string Key, string DisplayName);

[DebuggerDisplay("Name = {Name}, Url = {Url}, IsInternal = {IsInternal}")]
public sealed class UrlViewModel
{
    public string Name { get; }
    public Uri Url { get; }
    public bool IsInternal { get; }
    public bool IsInactive { get; }

    public UrlViewModel(string name, Uri url, bool isInternal, bool isInactive)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(url);

        Name = name;
        Url = url;
        IsInternal = isInternal;
        IsInactive = isInactive;
    }
}

public sealed record class VolumeViewModel(int index, string Source, string Target, string MountType, bool IsReadOnly) : IPropertyGridItem
{
    string IPropertyGridItem.Name => Source;
    string? IPropertyGridItem.Value => Target;

    // Source could be empty for an anomymous volume so it can't be used as a key.
    // Because there is no good key in data, use index of the volume in results.
    object IPropertyGridItem.Key => index;

    public bool MatchesFilter(string filter) =>
        Source?.Contains(filter, StringComparison.CurrentCultureIgnoreCase) == true ||
        Target?.Contains(filter, StringComparison.CurrentCultureIgnoreCase) == true;
}

public sealed record class HealthReportViewModel(string Name, HealthStatus? HealthStatus, string? Description, string? ExceptionText)
{
    private readonly string? _humanizedHealthStatus = HealthStatus?.Humanize();

    public string? DisplayedDescription
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(Description))
            {
                return Description;
            }

            if (!string.IsNullOrWhiteSpace(ExceptionText))
            {
                var newLineIndex = ExceptionText.IndexOfAny(['\n', '\r']);
                return newLineIndex > 0 ? ExceptionText[..newLineIndex] : ExceptionText;
            }

            return null;
        }
    }

    public bool MatchesFilter(string filter)
    {
        return
            Name?.Contains(filter, StringComparison.CurrentCultureIgnoreCase) == true ||
            Description?.Contains(filter, StringComparison.CurrentCultureIgnoreCase) == true ||
            _humanizedHealthStatus?.Contains(filter, StringComparison.OrdinalIgnoreCase) is true;
    }
}

[DebuggerDisplay("ResourceName = {ResourceName}, Type = {Type}")]
public sealed class RelationshipViewModel
{
    public string ResourceName { get; }
    public string Type { get; }

    public RelationshipViewModel(string resourceName, string type)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(resourceName);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        ResourceName = resourceName;
        Type = type;
    }
}

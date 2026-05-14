// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Model;
using Aspire.Dashboard.Resources;
using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.Localization;

namespace Aspire.Dashboard.Components.Controls.PropertyValues;

public partial class ResourceStateDescriptionValue
{
    private const string WaitingResourcePlaceholder = "{0}";
    private string _prefix = string.Empty;
    private string _suffix = string.Empty;
    private List<WaitingResource> _waitingResources = [];

    [Parameter, EditorRequired]
    public required string Value { get; set; }

    [Parameter, EditorRequired]
    public required string HighlightText { get; set; }

    [Parameter, EditorRequired]
    public required ResourceViewModel Resource { get; set; }

    [Parameter, EditorRequired]
    public required IDictionary<string, ResourceViewModel> ResourceByName { get; set; }

    [Parameter]
    public bool ShowHiddenResources { get; set; }

    [Inject]
    public required IStringLocalizer<Columns> Loc { get; init; }

    protected override void OnParametersSet()
    {
        _waitingResources = [];
        _prefix = string.Empty;
        _suffix = string.Empty;

        if (!Resource.TryGetWaitingForDependencies(out var dependencies))
        {
            return;
        }

        var waitingResourceNames = string.Join(", ", dependencies);
        if (!TrySplitWaitingForFormat(waitingResourceNames, out _prefix, out _suffix))
        {
            return;
        }

        foreach (var dependency in dependencies)
        {
            if (TryGetVisibleResource(dependency, out var resource))
            {
                _waitingResources.Add(new WaitingResource(resource, ResourceViewModel.GetResourceName(resource, ResourceByName)));
            }
            else
            {
                _waitingResources.Add(new WaitingResource(null, dependency));
            }
        }
    }

    private bool TrySplitWaitingForFormat(string waitingResourceNames, out string prefix, out string suffix)
    {
        var format = Loc[nameof(Columns.StateColumnResourceWaitingFor)].Value;
        var placeholderIndex = format.IndexOf(WaitingResourcePlaceholder, StringComparison.Ordinal);

        if (placeholderIndex >= 0)
        {
            prefix = format[..placeholderIndex];
            suffix = format[(placeholderIndex + WaitingResourcePlaceholder.Length)..];
            return true;
        }

        var resourceNamesIndex = Value.IndexOf(waitingResourceNames, StringComparison.Ordinal);
        if (resourceNamesIndex >= 0)
        {
            prefix = Value[..resourceNamesIndex];
            suffix = Value[(resourceNamesIndex + waitingResourceNames.Length)..];
            return true;
        }

        prefix = string.Empty;
        suffix = string.Empty;
        return false;
    }

    private bool TryGetVisibleResource(string resourceName, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out ResourceViewModel? resource)
    {
        if (ResourceViewModel.TryGetResourceByName(resourceName, ResourceByName, out resource) && !resource.IsResourceHidden(ShowHiddenResources))
        {
            return true;
        }

        resource = null;
        return false;
    }

    private sealed record WaitingResource(ResourceViewModel? Resource, string DisplayName);
}

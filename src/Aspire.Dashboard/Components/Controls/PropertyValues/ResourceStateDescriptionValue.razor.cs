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
    private CommandViewModel? StartCommand { get; set; }
    private bool IsStartCommandDisabled => StartCommand is null || StartCommand.State == CommandViewModelState.Disabled || OnExecuteCommandAsync is null || IsStartCommandExecuting;
    private bool IsStartCommandExecuting => StartCommand is not null && (IsCommandExecuting?.Invoke(Resource, StartCommand) ?? false);
    private string StartCommandTitle => StartCommand?.GetDisplayDescription() ?? StartCommand?.GetDisplayName() ?? string.Empty;

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

    [Parameter]
    public Func<ResourceViewModel, CommandViewModel, Task>? OnExecuteCommandAsync { get; set; }

    [Parameter]
    public Func<ResourceViewModel, CommandViewModel, bool>? IsCommandExecuting { get; set; }

    [Inject]
    public required IStringLocalizer<Columns> Loc { get; init; }

    [Inject]
    public required IStringLocalizer<ControlsStrings> ControlsLoc { get; init; }

    protected override void OnParametersSet()
    {
        _waitingResources = [];
        _prefix = string.Empty;
        _suffix = string.Empty;
        StartCommand = GetVisibleStartCommand();

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

    private CommandViewModel? GetVisibleStartCommand()
    {
        foreach (var command in Resource.Commands)
        {
            if (string.Equals(command.Name, CommandViewModel.StartCommand, StringComparisons.CommandName) &&
                command.State != CommandViewModelState.Hidden)
            {
                return command;
            }
        }

        return null;
    }

    private Task OnStartCommandAsync()
    {
        if (StartCommand is not { } startCommand ||
            IsStartCommandDisabled ||
            OnExecuteCommandAsync is not { } onExecuteCommandAsync)
        {
            return Task.CompletedTask;
        }

        return onExecuteCommandAsync(Resource, startCommand);
    }

    private sealed record WaitingResource(ResourceViewModel? Resource, string DisplayName);
}

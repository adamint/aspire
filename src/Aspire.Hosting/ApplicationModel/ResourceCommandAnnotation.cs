// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;

namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// Represents a command annotation for a resource.
/// </summary>
[DebuggerDisplay("Type = {GetType().Name,nq}, Name = {Name}")]
public sealed class ResourceCommandAnnotation : IResourceAnnotation
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ResourceCommandAnnotation"/> class.
    /// </summary>
    public ResourceCommandAnnotation(
        string name,
        string displayName,
        Func<UpdateCommandStateContext, ResourceCommandState> updateState,
        Func<ExecuteCommandContext, Task<ExecuteCommandResult>> executeCommand,
        string? displayDescription,
        object? parameter,
        string? confirmationMessage,
        string? iconName,
        IconVariant? iconVariant,
        bool isHighlighted,
        Func<UIStringContext, string>? getDisplayName,
        Func<UIStringContext, string>? getDisplayDescription,
        Func<UIStringContext, string>? getConfirmationMessage)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(displayName);
        ArgumentNullException.ThrowIfNull(updateState);
        ArgumentNullException.ThrowIfNull(executeCommand);

        Name = name;
        DisplayName = displayName;
        UpdateState = updateState;
        ExecuteCommand = executeCommand;
        DisplayDescription = displayDescription;
        Parameter = parameter;
        ConfirmationMessage = confirmationMessage;
        IconName = iconName;
        IconVariant = iconVariant;
        IsHighlighted = isHighlighted;
        GetDisplayName = getDisplayName;
        GetDisplayDescription = getDisplayDescription;
        GetConfirmationMessage = getConfirmationMessage;
    }

    /// <summary>
    /// The name of command. The name uniquely identifies the command.
    /// </summary>
    public string Name { get; }

    /// <summary>
    /// The display name visible in UI. If <see cref="GetDisplayName"/> is provided,
    /// this value is not used.
    /// </summary>
    public string DisplayName { get; }

    /// <summary>
    /// The display name visible in UI, based on the provided context.
    /// </summary>
    public Func<UIStringContext, string>? GetDisplayName { get; }

    /// <summary>
    /// A callback that is used to update the command state.
    /// The callback is executed when the command's resource snapshot is updated.
    /// </summary>
    public Func<UpdateCommandStateContext, ResourceCommandState> UpdateState { get; }

    /// <summary>
    /// A callback that is executed when the command is executed.
    /// The result is used to indicate success or failure in the UI.
    /// </summary>
    public Func<ExecuteCommandContext, Task<ExecuteCommandResult>> ExecuteCommand { get; }

    /// <summary>
    /// Optional description of the command, to be shown in the UI.
    /// Could be used as a tooltip. If <see cref="GetDisplayDescription"/> is provided,
    /// this value is not used.
    /// </summary>
    public string? DisplayDescription { get; }

    /// <summary>
    /// Optional description of the command, to be shown in the UI based on the provided context.
    /// Could be used as a tooltip.
    /// </summary>
    public Func<UIStringContext, string>? GetDisplayDescription { get; }

    /// <summary>
    /// Optional parameter that configures the command in some way.
    /// Clients must return any value provided by the server when invoking the command.
    /// </summary>
    public object? Parameter { get; }

    /// <summary>
    /// When a confirmation message is specified, the UI will prompt with an OK/Cancel dialog
    /// and the confirmation message before starting the command.
    ///
    /// If <see cref="GetConfirmationMessage"/> is provided, this value is not used.
    /// </summary>
    public string? ConfirmationMessage { get; }

    /// <summary>
    /// When a confirmation message is specified, the UI will prompt with an OK/Cancel dialog
    /// and the confirmation message before starting the command.
    /// </summary>
    public Func<UIStringContext, string>? GetConfirmationMessage { get; }

    /// <summary>
    /// The icon name for the command. The name should be a valid FluentUI icon name. https://aka.ms/fluentui-system-icons
    /// </summary>
    public string? IconName { get; }

    /// <summary>
    /// The icon variant for the command.
    /// </summary>
    public IconVariant? IconVariant { get; }

    /// <summary>
    /// A flag indicating whether the command is highlighted in the UI.
    /// </summary>
    public bool IsHighlighted { get; }
}

/// <summary>
/// The icon variant.
/// </summary>
public enum IconVariant
{
    /// <summary>
    /// Regular variant of icons.
    /// </summary>
    Regular,
    /// <summary>
    /// Filled variant of icons.
    /// </summary>
    Filled
}

/// <summary>
/// A factory for <see cref="ExecuteCommandResult"/>.
/// </summary>
public static class CommandResults
{
    /// <summary>
    /// Produces a success result.
    /// </summary>
    public static ExecuteCommandResult Success() => new ExecuteCommandResult { Success = true };
}

/// <summary>
/// The result of executing a command. Returned from <see cref="ResourceCommandAnnotation.ExecuteCommand"/>.
/// </summary>
public sealed class ExecuteCommandResult
{
    /// <summary>
    /// A flag that indicates whether the command was successful.
    /// </summary>
    public required bool Success { get; init; }

    /// <summary>
    /// An optional error message that can be set when the command is unsuccessful.
    /// </summary>
    public string? ErrorMessage { get; init; }
}

/// <summary>
/// Context for <see cref="ResourceCommandAnnotation.UpdateState"/>.
/// </summary>
public sealed class UpdateCommandStateContext
{
    /// <summary>
    /// The resource snapshot.
    /// </summary>
    public required CustomResourceSnapshot ResourceSnapshot { get; init; }

    /// <summary>
    /// The service provider.
    /// </summary>
    public required IServiceProvider ServiceProvider { get; init; }
}

/// <summary>
/// Context for <see cref="ResourceCommandAnnotation.ExecuteCommand"/>.
/// </summary>
public sealed class ExecuteCommandContext
{
    /// <summary>
    /// The service provider.
    /// </summary>
    public required IServiceProvider ServiceProvider { get; init; }

    /// <summary>
    /// The resource name.
    /// </summary>
    public required string ResourceName { get; init; }

    /// <summary>
    /// The cancellation token.
    /// </summary>
    public required CancellationToken CancellationToken { get; init; }
}

/// <summary>
/// Context for <see cref="ResourceCommandAnnotation.DisplayName"/> and <see cref="ResourceCommandAnnotation.DisplayDescription"/>.
/// </summary>
public sealed class UIStringContext
{
    /// <summary>
    /// The locale of the client.
    /// </summary>
    public required string Locale { get; init; }
}

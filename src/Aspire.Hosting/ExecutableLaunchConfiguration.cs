// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Aspire.Hosting;

internal static class ExecutableLaunchMode
{
    public const string Debug = "Debug";
    public const string NoDebug = "NoDebug";
}

/// <summary>
/// Base properties for all executable launch configurations.
/// </summary>
/// <param name="type">Launch configuration type indicator.</param>
public abstract class ExecutableLaunchConfiguration(string type)
{
    /// <summary>
    /// The launch configuration type indicator.
    /// </summary>
    [JsonPropertyName("type")]
    public string Type { get; set; } = type;

    /// <summary>
    /// Specifies the launch mode. Currently supported modes are Debug (run the project under the debugger) and NoDebug (run the project without debugging).
    /// </summary>
    [JsonPropertyName("mode")]
    public string Mode { get; set; } = System.Diagnostics.Debugger.IsAttached ? ExecutableLaunchMode.Debug : ExecutableLaunchMode.NoDebug;
}

/// <summary>
/// Controls the presentation of the debug configuration in the UI.
/// </summary>
public class PresentationOptions
{
    /// <summary>
    /// The order of this item in the debug configuration dropdown.
    /// </summary>
    [JsonPropertyName("order")]
    public int? Order { get; set; }

    /// <summary>
    /// The group this configuration belongs to.
    /// </summary>
    [JsonPropertyName("group")]
    public string? Group { get; set; }

    /// <summary>
    /// Whether this configuration should be hidden from the UI.
    /// </summary>
    [JsonPropertyName("hidden")]
    public bool? Hidden { get; set; }
}

/// <summary>
/// Specifies an action to take when the server is ready.
/// </summary>
public enum ServerReadyActionKind
{
    /// <summary>
    /// Opens the server URL in an external web browser.
    /// </summary>
    OpenExternally,

    /// <summary>
    /// Launches a Chrome debugging session.
    /// </summary>
    DebugWithChrome,

    /// <summary>
    /// Launches a Microsoft Edge debugging session.
    /// </summary>
    DebugWithEdge,

    /// <summary>
    /// Starts another VS Code debug configuration.
    /// </summary>
    StartDebugging
}

/// <summary>
/// Specifies an action to take when the server is ready.
/// </summary>
public readonly record struct ServerReadyActionAction
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ServerReadyActionAction"/> struct.
    /// </summary>
    /// <param name="value">The action name as understood by VS Code.</param>
    /// <exception cref="ArgumentException">Thrown when <paramref name="value"/> is <see langword="null"/>, empty, or whitespace.</exception>
    public ServerReadyActionAction(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        Value = value;
    }

    /// <summary>
    /// Gets the action name as understood by VS Code.
    /// </summary>
    public string Value { get; }

    /// <summary>
    /// Opens the server URL in an external web browser.
    /// </summary>
    public static ServerReadyActionAction OpenExternally { get; } = new("openExternally");

    /// <summary>
    /// Launches a Chrome debugging session.
    /// </summary>
    public static ServerReadyActionAction DebugWithChrome { get; } = new("debugWithChrome");

    /// <summary>
    /// Launches a Microsoft Edge debugging session.
    /// </summary>
    public static ServerReadyActionAction DebugWithEdge { get; } = new("debugWithEdge");

    /// <summary>
    /// Starts another VS Code debug configuration.
    /// </summary>
    public static ServerReadyActionAction StartDebugging { get; } = new("startDebugging");

    /// <summary>
    /// Creates a <see cref="ServerReadyActionAction"/> for a known action kind.
    /// </summary>
    /// <param name="kind">The known action kind.</param>
    /// <returns>A <see cref="ServerReadyActionAction"/> representing <paramref name="kind"/>.</returns>
    public static ServerReadyActionAction FromKind(ServerReadyActionKind kind) => kind switch
    {
        ServerReadyActionKind.OpenExternally => OpenExternally,
        ServerReadyActionKind.DebugWithChrome => DebugWithChrome,
        ServerReadyActionKind.DebugWithEdge => DebugWithEdge,
        ServerReadyActionKind.StartDebugging => StartDebugging,
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    /// <summary>
    /// Attempts to map this action to a <see cref="ServerReadyActionKind"/>.
    /// </summary>
    /// <param name="kind">When this method returns <see langword="true"/>, contains the mapped kind.</param>
    /// <returns><see langword="true"/> if <see cref="Value"/> matches a known action; otherwise, <see langword="false"/>.</returns>
    public bool TryGetKind(out ServerReadyActionKind kind)
    {
        kind = Value switch
        {
            "openExternally" => ServerReadyActionKind.OpenExternally,
            "debugWithChrome" => ServerReadyActionKind.DebugWithChrome,
            "debugWithEdge" => ServerReadyActionKind.DebugWithEdge,
            "startDebugging" => ServerReadyActionKind.StartDebugging,
            _ => default
        };

        return Value is "openExternally" or "debugWithChrome" or "debugWithEdge" or "startDebugging";
    }

    /// <inheritdoc/>
    public override string ToString() => Value;
}

/// <summary>
/// Serializes <see cref="ServerReadyActionAction"/> as a string value.
/// </summary>
internal sealed class ServerReadyActionActionJsonConverter : JsonConverter<ServerReadyActionAction?>
{
    public override ServerReadyActionAction? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType is JsonTokenType.Null)
        {
            return null;
        }

        if (reader.TokenType is not JsonTokenType.String)
        {
            throw new JsonException($"Expected string or null for {nameof(ServerReadyAction.Action)}.");
        }

        var value = reader.GetString();
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new JsonException($"{nameof(ServerReadyAction.Action)} cannot be empty.");
        }

        // Do not validate values here. VS Code supports additional actions and debug adapters may introduce more.
        return new ServerReadyActionAction(value);
    }

    public override void Write(Utf8JsonWriter writer, ServerReadyActionAction? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            writer.WriteNullValue();
            return;
        }

        writer.WriteStringValue(value.Value.Value);
    }
}

/// <summary>
/// Specifies an action to take when the server is ready.
/// </summary>
public class ServerReadyAction
{
    /// <summary>
    /// The action to take.
    /// </summary>
    [JsonPropertyName("action")]
    [JsonConverter(typeof(ServerReadyActionActionJsonConverter))]
    public ServerReadyActionAction? Action { get; set; }

    /// <summary>
    /// The pattern to match in the debug console or integrated terminal output.
    /// </summary>
    [JsonPropertyName("pattern")]
    public string? Pattern { get; set; }

    /// <summary>
    /// The URI format to open. Can include ${port} placeholder.
    /// </summary>
    [JsonPropertyName("uriFormat")]
    public string? UriFormat { get; set; }

    /// <summary>
    /// The root directory used to resolve source maps and client-side files when launching a browser-based debug session.
    /// </summary>
    /// <remarks>
    /// This maps to VS Code's <c>serverReadyAction.webRoot</c> property.
    /// </remarks>
    [JsonPropertyName("webRoot")]
    public string? WebRoot { get; set; }

    /// <summary>
    /// The name of the debug configuration to start when <see cref="Action"/> is <see cref="ServerReadyActionAction.StartDebugging"/>.
    /// </summary>
    /// <remarks>
    /// This maps to VS Code's <c>serverReadyAction.name</c> property.
    /// </remarks>
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    /// <summary>
    /// Additional debug configuration to use when starting a follow-up debug session.
    /// </summary>
    /// <remarks>
    /// This maps to VS Code's <c>serverReadyAction.config</c> property.
    /// The schema for this object depends on the debug adapter being used, so it is represented as arbitrary JSON.
    /// </remarks>
    [JsonPropertyName("config")]
    public JsonObject? Config { get; set; }

    /// <summary>
    /// Indicates whether the browser session started by the <see cref="Action"/> should be closed when the server process stops.
    /// </summary>
    /// <remarks>
    /// This maps to VS Code's <c>serverReadyAction.killOnServerStop</c> property.
    /// </remarks>
    [JsonPropertyName("killOnServerStop")]
    public bool? KillOnServerStop { get; set; }
}

/// <summary>
/// Base properties for all debuggers. These properties come from https://code.visualstudio.com/docs/debugtest/debugging-configuration, and can
/// be extended to map to the properties made available by any VS Code debug adapter.
/// </summary>
public abstract class VSCodeDebuggerProperties
{
    /// <summary>
    /// The type of debugger to use for this launch configuration.
    /// </summary>
    [JsonPropertyName("type")]
    public abstract string Type { get; set; }

    /// <summary>
    /// The request type of this launch configuration. Currently, launch and attach are supported. Defaults to launch.
    /// </summary>
    [JsonPropertyName("request")]
    public virtual string Request { get; set; } = "launch";

    /// <summary>
    /// The user-friendly name to appear in the Debug launch configuration dropdown.
    /// </summary>
    [JsonPropertyName("name")]
    public abstract string Name { get; set; }

    /// <summary>
    /// The working directory for the program being debugged.
    /// </summary>
    [JsonPropertyName("cwd")]
    public abstract string WorkingDirectory { get; init; }

    /// <summary>
    /// Controls how the debug configuration is displayed in the UI.
    /// </summary>
    [JsonPropertyName("presentation")]
    public PresentationOptions? Presentation { get; set; }

    /// <summary>
    /// The label of a task to launch before the start of a debug session. Can be set to ${defaultBuildTask} to use the default build task.
    /// </summary>
    [JsonPropertyName("preLaunchTask")]
    public string? PreLaunchTask { get; set; }

    /// <summary>
    /// The name of a task to launch at the very end of a debug session.
    /// </summary>
    [JsonPropertyName("postDebugTask")]
    public string? PostDebugTask { get; set; }

    /// <summary>
    /// Controls the visibility of the Debug console panel during a debugging session.
    /// Possible values: "neverOpen", "openOnSessionStart", "openOnFirstSessionStart".
    /// </summary>
    [JsonPropertyName("internalConsoleOptions")]
    public string? InternalConsoleOptions { get; set; }

    /// <summary>
    /// Allows you to connect to a specified port instead of launching the debug adapter.
    /// </summary>
    [JsonPropertyName("debugServer")]
    public int? DebugServer { get; set; }

    /// <summary>
    /// Specifies an action to take when the program outputs a specific message (e.g., opening a URL in a web browser).
    /// </summary>
    [JsonPropertyName("serverReadyAction")]
    public ServerReadyAction? ServerReadyAction { get; set; }
}

/// <summary>
/// Base class for executable launch configurations that include debugger-specific properties.
/// </summary>
/// <typeparam name="T">The type of debugger properties to include.</typeparam>
/// <param name="type">Launch configuration type indicator.</param>
public abstract class ExecutableLaunchConfigurationWithVSCodeDebuggerProperties<T>(string type) : ExecutableLaunchConfiguration(type)
    where T : VSCodeDebuggerProperties
{
    /// <summary>
    /// Debugger-specific properties.
    /// </summary>
    [JsonPropertyName("debugger_properties")]
    public required T DebuggerProperties { get; set; }
}

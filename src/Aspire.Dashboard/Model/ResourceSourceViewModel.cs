// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text;

namespace Aspire.Dashboard.Model;

public class ResourceSourceViewModel(string value, string? contentAfterValue, string valueToVisualize, string tooltip)
{
    public string Value { get; } = value;
    public string? ContentAfterValue { get; } = contentAfterValue;
    public string ValueToVisualize { get; } = valueToVisualize;
    public string Tooltip { get; } = tooltip;

    internal static ResourceSourceViewModel? GetSourceViewModel(ResourceViewModel resource)
    {
        string? executablePath;
        (List<string>? Arguments, string? ArgumentsString, string FullCommandLine)? commandLineInfo;

        if (resource.TryGetExecutablePath(out var path))
        {
            executablePath = path;
            commandLineInfo = GetCommandLineInfo(resource, executablePath);
        }
        else
        {
            executablePath = null;
            commandLineInfo = null;
        }

        // NOTE projects are also executables, so we have to check for projects first
        if (resource.IsProject() && resource.TryGetProjectPath(out var projectPath))
        {
            if (commandLineInfo is { ArgumentsString: { } argumentsString, FullCommandLine: { } fullCommandLine })
            {
                return new ResourceSourceViewModel(value: Path.GetFileName(projectPath), contentAfterValue: argumentsString, valueToVisualize: fullCommandLine, tooltip: fullCommandLine);
            }

            // default to project path if there is no executable path or executable arguments
            return new ResourceSourceViewModel(value: Path.GetFileName(projectPath), contentAfterValue: commandLineInfo?.ArgumentsString, valueToVisualize: projectPath, tooltip: projectPath);
        }

        if (executablePath is not null)
        {
            return new ResourceSourceViewModel(value: Path.GetFileName(executablePath), contentAfterValue: commandLineInfo?.ArgumentsString, valueToVisualize: commandLineInfo?.FullCommandLine ?? executablePath, tooltip: commandLineInfo?.FullCommandLine ?? string.Empty);
        }

        if (resource.TryGetContainerImage(out var containerImage))
        {
            return new ResourceSourceViewModel(value: containerImage, contentAfterValue: null, valueToVisualize: containerImage, tooltip: containerImage);
        }

        if (resource.Properties.TryGetValue(KnownProperties.Resource.Source, out var property) && property.Value is { HasStringValue: true, StringValue: var value })
        {
            return new ResourceSourceViewModel(value, contentAfterValue: null, valueToVisualize: value, tooltip: value);
        }

        return null;
    }

    private static (List<string>? Arguments, string? ArgumentsString, string FullCommandLine)? GetCommandLineInfo(ResourceViewModel resource, string executablePath)
    {
        if (resource.TryGetExecutableArguments(out var arguments))
        {
            if (arguments.IsDefaultOrEmpty)
            {
                return (Arguments: null, ArgumentsString: null, FullCommandLine: executablePath);
            }

            var escapedArguments = arguments.Select(EscapeCommandLineArgument).ToList();

            // if the command line arguments start with DCP defaults, hide them
            // these come from DcpExecutor#PrepareProjectExecutables and need to be kept in sync

            if (escapedArguments.Count > 3 && escapedArguments.Take(3).SequenceEqual(["run", "--no-build", "--project"], StringComparers.CommandLineArguments))
            {
                escapedArguments.RemoveRange(0, 4); // remove the project path too
            }
            else if (escapedArguments.Count > 4 && escapedArguments.Take(4).SequenceEqual(["watch", "--non-interactive", "--no-hot-reload", "--project"], StringComparers.CommandLineArguments))
            {
                escapedArguments.RemoveRange(0, 5); // remove the project path too
            }

            if (escapedArguments.Count > 1 && string.Equals(escapedArguments[0], "-c", StringComparisons.CommandLineArguments))
            {
                escapedArguments.RemoveRange(0, 2);
            }

            if (escapedArguments.Count > 0 && string.Equals(escapedArguments[0], "--no-launch-profile", StringComparisons.CommandLineArguments))
            {
                escapedArguments.RemoveAt(0);
            }

            if (escapedArguments.Count == 0)
            {
                return (Arguments: [], ArgumentsString: string.Empty, FullCommandLine: executablePath);
            }

            var argumentsString = string.Join(' ', escapedArguments);
            return (Arguments: escapedArguments, argumentsString, $"{executablePath} {argumentsString}");
        }

        return null;

        // This method doesn't account for all cases, but does the most common
        static string EscapeCommandLineArgument(string argument)
        {
            if (string.IsNullOrEmpty(argument))
            {
                return "\"\"";
            }

            if (argument.Contains(' ') || argument.Contains('"') || argument.Contains('\\'))
            {
                var escapedArgument = new StringBuilder();
                escapedArgument.Append('"');

                for (int i = 0; i < argument.Length; i++)
                {
                    char c = argument[i];
                    switch (c)
                    {
                        case '\\':
                            // Escape backslashes
                            escapedArgument.Append('\\');
                            escapedArgument.Append('\\');
                            break;
                        case '"':
                            // Escape quotes
                            escapedArgument.Append('\\');
                            escapedArgument.Append('"');
                            break;
                        default:
                            escapedArgument.Append(c);
                            break;
                    }
                }

                escapedArgument.Append('"');
                return escapedArgument.ToString();
            }

            return argument;
        }
    }
}

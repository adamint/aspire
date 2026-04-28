// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using Aspire.Cli.Interaction;
using Aspire.Cli.Resources;

namespace Aspire.Cli.Commands;

internal static class CommandInteractionHelpers
{
    internal static void DisplaySeeLogsMessage(IInteractionService interactionService, string? logFilePath)
    {
        if (logFilePath is not null)
        {
            interactionService.DisplayMessage(KnownEmojis.PageFacingUp, string.Format(CultureInfo.CurrentCulture, InteractionServiceStrings.SeeLogsAt, logFilePath));
        }
    }
}

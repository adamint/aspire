// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using Aspire.Cli.Interaction;
using Microsoft.Extensions.DependencyInjection;

namespace Aspire.Cli.Utils;

internal static class ExtensionHelper
{
    public static bool IsExtensionHost(IServiceProvider serviceProvider, [NotNullWhen(true)] out ExtensionInteractionService? interactionService)
    {
        if (serviceProvider.GetRequiredService<IInteractionService>() is ExtensionInteractionService extensionInteractionService)
        {
            interactionService = extensionInteractionService;
            return true;
        }

        interactionService = null;
        return false;
    }
}

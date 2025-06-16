// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Utils;

namespace Aspire.Cli.Backchannel;

internal sealed class AppHostIncompatibleException(string message, string requiredCapability) : IncompatibilityException(message, requiredCapability);

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Components.Pages;
using Microsoft.AspNetCore.WebUtilities;

namespace Aspire.Dashboard.Extensions;

public static class ComponentExtensions
{
    public static void AfterViewModelChanged<T>(this IStatefulPage<T> page)
    {
        var (path, queryParameters) = page.GetUriFromViewModel();
        page.NavigationManager.NavigateTo(queryParameters.Count == 0
            ? path
            : QueryHelpers.AddQueryString(path, queryParameters));
    }
}

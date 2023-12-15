// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.WebUtilities;

namespace Aspire.Dashboard.Components.Pages;

public abstract class StatefulPage<TViewModel> : ComponentBase
{
    protected abstract TViewModel GetViewModelFromQuery();
    protected abstract (string Path, Dictionary<string, string?> QueryParameters) GetUriFromViewModel();

    public abstract NavigationManager NavigationManager { get; set; }

    public void AfterViewModelChanged()
    {
        var (path, queryParameters) = GetUriFromViewModel();
        NavigationManager.NavigateTo(queryParameters.Count == 0
            ? path
            : QueryHelpers.AddQueryString(path, queryParameters));
    }
}

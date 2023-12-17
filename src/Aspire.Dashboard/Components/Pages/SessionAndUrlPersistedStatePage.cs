// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Server.ProtectedBrowserStorage;
using Microsoft.AspNetCore.WebUtilities;

namespace Aspire.Dashboard.Components.Pages;

public abstract class SessionAndUrlPersistedStatePage<TViewModel>(string sessionStorageKey) : ComponentBase
{
    public abstract NavigationManager NavigationManager { get; }
    public abstract ProtectedSessionStorage SessionStorage { get; }

    public TViewModel ViewModel { get; private set; } = default!;

    protected override void OnParametersSet()
    {
        base.OnParametersSet();
        ViewModel = GetViewModelFromQuery();
    }

    public abstract TViewModel GetViewModelFromQuery();
    public abstract (string Path, Dictionary<string, string?> QueryParameters) GetUrlFromViewModel();

    private string ConvertPathAndParametersToString()
    {
        var (path, queryParameters) = GetUrlFromViewModel();
        return queryParameters.Count == 0
            ? path
            : QueryHelpers.AddQueryString(path, queryParameters);
    }

    public async Task AfterViewModelChanged()
    {
        NavigationManager.NavigateTo(ConvertPathAndParametersToString());
        Debug.Assert(ViewModel is not null);
        await SessionStorage.SetAsync(sessionStorageKey, ViewModel);
    }
}

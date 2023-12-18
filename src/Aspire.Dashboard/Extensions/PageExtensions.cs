﻿// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Components.Pages;
using Microsoft.AspNetCore.WebUtilities;

namespace Aspire.Dashboard.Extensions;

public static class PageExtensions
{
    public static async Task AfterViewModelChangedAsync<TViewModel, TSerializableViewModel>(this IPageWithSessionAndUrlState<TViewModel, TSerializableViewModel> page) where TSerializableViewModel : class
    {
        var serializableViewModel = page.ConvertViewModelToSerializable();
        var (path, queryParameters) = page.GetUrlFromSerializableViewModel(serializableViewModel);

        var pathWithParameters = queryParameters.Count == 0
            ? path
            : QueryHelpers.AddQueryString(path, queryParameters);
        page.NavigationManager.NavigateTo(pathWithParameters);

        await page.SessionStorage.SetAsync(page.SessionStorageKey, serializableViewModel).ConfigureAwait(false);
    }

    public static async Task InitializeViewModelAsync<TViewModel, TSerializableViewModel>(this IPageWithSessionAndUrlState<TViewModel, TSerializableViewModel> page) where TSerializableViewModel : class
    {
        if (string.Equals(page.BasePath, page.NavigationManager.ToBaseRelativePath(page.NavigationManager.Uri)))
        {
            var result = await page.SessionStorage.GetAsync<TSerializableViewModel>(page.SessionStorageKey).ConfigureAwait(false);
            if (result is { Success: true, Value: not null })
            {
                page.NavigationManager.NavigateTo(GetUrlFromPathAndParameterParts(page.GetUrlFromSerializableViewModel(result.Value)));
                return;
            }
        }

        page.ViewModel = page.GetViewModelFromQuery();
    }

    private static string GetUrlFromPathAndParameterParts((string Path, Dictionary<string, string?> QueryParameters) parts)
    {
        var (path, queryParameters) = parts;

        return queryParameters.Count == 0
            ? path
            : QueryHelpers.AddQueryString(path, queryParameters);
    }
}

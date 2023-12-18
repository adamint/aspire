// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Server.ProtectedBrowserStorage;

namespace Aspire.Dashboard.Components.Pages;

public interface IPageWithSessionAndUrlState<TViewModel, TSerializableViewModel>
    where TSerializableViewModel : class
{
    public string BasePath { get; }
    public string SessionStorageKey { get; }
    public NavigationManager NavigationManager { get; set; }
    public ProtectedSessionStorage SessionStorage { get; }

    public TViewModel ViewModel { get; set; }

    public TViewModel GetViewModelFromQuery();
    public (string Path, Dictionary<string, string?> QueryParameters) GetUrlFromSerializableViewModel(TSerializableViewModel serializable);
    public TSerializableViewModel ConvertViewModelToSerializable();
}

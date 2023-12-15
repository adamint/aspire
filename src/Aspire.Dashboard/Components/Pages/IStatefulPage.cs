// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.AspNetCore.Components;

namespace Aspire.Dashboard.Components.Pages;

public interface IStatefulPage<out TViewModel>
{
    TViewModel GetViewModelFromQuery();
    (string Path, Dictionary<string, string?> QueryParameters) GetUriFromViewModel();

    public NavigationManager NavigationManager { get; set; }
}

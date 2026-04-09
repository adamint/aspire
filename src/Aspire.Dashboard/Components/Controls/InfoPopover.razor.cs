// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.AspNetCore.Components;

namespace Aspire.Dashboard.Components.Controls;

public partial class InfoPopover
{
    private bool _popoverVisible;

    [Parameter, EditorRequired]
    public required string AnchorId { get; set; }

    [Parameter, EditorRequired]
    public required RenderFragment ChildContent { get; set; }
}

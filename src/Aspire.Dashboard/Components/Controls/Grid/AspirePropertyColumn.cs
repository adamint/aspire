// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
using Microsoft.FluentUI.AspNetCore.Components;

namespace Aspire.Dashboard.Components.Controls.Grid;

public class AspirePropertyColumn<TGridItem, TProp> : PropertyColumn<TGridItem, TProp>
{
    protected override void OnParametersSet()
    {
        HeaderCellItemTemplate = AspireFluentDataGridHeaderCell.RenderHeaderContent(Grid);
        base.OnParametersSet();
    }
}

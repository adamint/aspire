// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.AspNetCore.Components.Web;

namespace Aspire.Dashboard.Components.Controls.NestedDataGrid.ColumnContent;

public interface IAspireDataGridColumnContent<TGridItem>
{
    string AriaLabel { get; set; }
    string? Href { get; set; }
    Func<MouseEventArgs, Task>? OnClick { get; set; }
    Func<TGridItem, bool>? RowHasContent { get; set; }
    TGridItem Item { get; set; }
}

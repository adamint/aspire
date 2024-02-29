using Microsoft.AspNetCore.Components.Web;

namespace Aspire.Dashboard.Components.Controls.NestedDataGrid;

internal interface IAspireDataGridColumn
{
    public string? Href { get; set; }
    public Func<MouseEventArgs, Task>? OnClick { get; set; }
    public string AriaLabel { get; set; }
}
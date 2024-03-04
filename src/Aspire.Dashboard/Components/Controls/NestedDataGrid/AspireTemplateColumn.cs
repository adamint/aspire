using Aspire.Dashboard.Components.Controls.NestedDataGrid.ColumnContent;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.FluentUI.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Aspire.Dashboard.Components.Controls.NestedDataGrid;

public class AspireTemplateColumn<TGridItem> : TemplateColumn<TGridItem>, IAspireDataGridColumn
{
    [Inject]
    public required IJSRuntime JS { get; set; }

    [Parameter]
    public string? Href { get; set; }

    [Parameter]
    public required string AriaLabel { get; set; }

    [Parameter]
    public Func<MouseEventArgs, Task>? OnClick { get; set; }

    [Parameter]
    public Func<TGridItem, bool>? RowHasContent { get; set; }

    /// <inheritdoc />
    protected override void CellContent(RenderTreeBuilder builder, TGridItem item)
    {
        builder.OpenComponent<TemplateColumnContent<TGridItem>>(0);

        builder.AddComponentParameter(1, nameof(TemplateColumnContent<TGridItem>.Href), Href);
        builder.AddComponentParameter(2, nameof(TemplateColumnContent<TGridItem>.OnClick), OnClick);
        builder.AddComponentParameter(3, nameof(TemplateColumnContent<TGridItem>.Content), ChildContent(item));
        builder.AddComponentParameter(4, nameof(TemplateColumnContent<TGridItem>.AriaLabel), AriaLabel);
        builder.AddComponentParameter(5, nameof(TemplateColumnContent<TGridItem>.Item), item);
        builder.AddComponentParameter(6, nameof(PropertyColumnContent<TGridItem>.RowHasContent), RowHasContent);

        builder.CloseComponent();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        await base.OnAfterRenderAsync(firstRender);
    }
}

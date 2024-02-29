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

    /// <inheritdoc />
    protected override void CellContent(RenderTreeBuilder builder, TGridItem item)
    {
        builder.OpenComponent<TemplateColumnContent>(0);
        
        builder.AddComponentParameter(1, nameof(TemplateColumnContent.Href), Href);
        builder.AddComponentParameter(2, nameof(TemplateColumnContent.OnClick), OnClick);
        builder.AddComponentParameter(3, nameof(TemplateColumnContent.Content), ChildContent(item));
        builder.AddComponentParameter(4, nameof(TemplateColumnContent.AriaLabel), AriaLabel);
        
        builder.CloseComponent();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        await base.OnAfterRenderAsync(firstRender);
    }
}
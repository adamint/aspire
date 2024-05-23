using Aspire.Dashboard.Model;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Aspire.Dashboard.Components.Resize;

public partial class BrowserDimensionWatcher : ComponentBase
{
    [Parameter]
    public ViewportInformation? ViewportInformation { get; set; }

    [Parameter]
    public EventCallback<ViewportInformation?> ViewportInformationChanged { get; set; }

    [Inject]
    public required IJSRuntime JS { get; init; }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            var viewport = await JS.InvokeAsync<ViewportSize>("window.getWindowDimensions");
            ViewportInformation = GetViewportInformation(viewport);
            await ViewportInformationChanged.InvokeAsync(ViewportInformation);
        }

        await base.OnAfterRenderAsync(firstRender);
    }

    private static ViewportInformation GetViewportInformation(ViewportSize viewportSize)
    {
        var isSmall = viewportSize.Width < 768;
        return new ViewportInformation(!isSmall, viewportSize.Height, viewportSize.Width);
    }

    private record ViewportSize(int Width, int Height);
}


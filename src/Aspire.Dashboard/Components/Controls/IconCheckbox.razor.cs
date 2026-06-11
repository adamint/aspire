// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Utils;
using Microsoft.AspNetCore.Components;
using Microsoft.FluentUI.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Aspire.Dashboard.Components;

/// <summary>
/// An icon-only checkbox that exposes proper checkbox semantics to assistive tech.
/// </summary>
/// <remarks>
/// FluentButton renders a shadow-DOM button that remains exposed as role=button, so the
/// checkbox semantics need to live on this focusable element. A small JS helper handles
/// the Space key here so Tab/Shift+Tab keep their native focus behavior while Space
/// cannot scroll the page or bubble to an enclosing grid's row activation.
/// </remarks>
public partial class IconCheckbox : ComponentBase, IAsyncDisposable
{
    private const string JsModulePath = "./Components/Controls/IconCheckbox.razor.js";

    private ElementReference _element;
    private IJSObjectReference? _jsModule;
    private bool _keyboardInitialized;

    [Inject]
    public required IJSRuntime JS { get; init; }

    /// <summary>
    /// The icon rendered inside the checkbox.
    /// </summary>
    [Parameter]
    public required Icon Icon { get; set; }

    /// <summary>
    /// The current aria-checked state. Use <c>"true"</c>, <c>"false"</c>, or <c>"mixed"</c>.
    /// </summary>
    [Parameter]
    public required string AriaChecked { get; set; }

    /// <summary>
    /// The accessible name used for both <c>title</c> and <c>aria-label</c>.
    /// </summary>
    [Parameter]
    public required string AccessibleLabel { get; set; }

    /// <summary>
    /// Invoked when the checkbox is activated (click or Space).
    /// </summary>
    [Parameter]
    public EventCallback OnClick { get; set; }

    /// <summary>
    /// Tab index for the checkbox. Defaults to <c>"0"</c>; pass <c>"-1"</c> to remove the
    /// checkbox from the tab order without disabling pointer interactions.
    /// </summary>
    [Parameter]
    public string TabIndex { get; set; } = "0";

    /// <summary>
    /// When set to <c>"true"</c>, exposes the checkbox as disabled and skips the Space-key handler.
    /// </summary>
    [Parameter]
    public string? AriaDisabled { get; set; }

    /// <summary>
    /// Additional CSS classes appended to the root element.
    /// </summary>
    [Parameter]
    public string? CssClass { get; set; }

    /// <summary>
    /// Whether the click event should be prevented from propagating to ancestors.
    /// Defaults to <c>true</c> so the checkbox does not also activate a surrounding row.
    /// </summary>
    [Parameter]
    public bool StopPropagation { get; set; } = true;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            _jsModule = await JS.InvokeAsync<IJSObjectReference>("import", JsModulePath);
            await _jsModule.InvokeVoidAsync("initializeIconCheckboxKeyboard", _element);
            _keyboardInitialized = true;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_jsModule is not null)
        {
            if (_keyboardInitialized)
            {
                try
                {
                    await _jsModule.InvokeVoidAsync("disposeIconCheckboxKeyboard", _element);
                }
                catch (JSDisconnectedException)
                {
                    // The browser may already be gone when the component is disposed.
                }
                catch (OperationCanceledException)
                {
                    // The browser may already be gone when the component is disposed.
                }
            }

            await JSInteropHelpers.SafeDisposeAsync(_jsModule);
        }
    }
}

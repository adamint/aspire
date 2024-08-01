// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Model.Otlp;
using Microsoft.AspNetCore.Components;
using Microsoft.FluentUI.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Aspire.Dashboard.Components.Dialogs;

public partial class TextVisualizerDialog : ComponentBase, IAsyncDisposable
{
    public const string XmlFormat = "xml";
    public const string JsonFormat = "json";
    public const string PlaintextFormat = "plaintext";

    private readonly string _copyButtonId = $"copy-{Guid.NewGuid():N}";
    private readonly string _openSelectFormatButtonId = $"select-format-{Guid.NewGuid():N}";

    private IJSObjectReference? _jsModule;
    private List<SelectViewModel<string>> _options = null!;

    public HashSet<string?> EnabledOptions { get; } = [];
    public string FormattedText { get; private set; } = string.Empty;
    public string FormatKind { get; private set; } = PlaintextFormat;

    [Inject]
    public required IJSRuntime JS { get; init; }

    [Inject]
    public required ThemeManager ThemeManager { get; init; }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            _jsModule = await JS.InvokeAsync<IJSObjectReference>("import", "/Components/Dialogs/TextVisualizerDialog.razor.js");
        }

        if (_jsModule is not null && FormatKind != PlaintextFormat)
        {
            await _jsModule.InvokeVoidAsync("connectObserver");
        }
    }

    protected override void OnParametersSet()
    {
        EnabledOptions.Clear();
        EnabledOptions.Add(PlaintextFormat);

        _options = [
            new SelectViewModel<string> { Id = PlaintextFormat, Name = Loc[nameof(Resources.Dialogs.TextVisualizerDialogPlaintextFormat)] },
            new SelectViewModel<string> { Id = JsonFormat, Name = Loc[nameof(Resources.Dialogs.TextVisualizerDialogJsonFormat)] },
            new SelectViewModel<string> { Id = XmlFormat, Name = Loc[nameof(Resources.Dialogs.TextVisualizerDialogXmlFormat)] }
        ];

        if (TryFormatJson())
        {
            EnabledOptions.Add(JsonFormat);
        }
        else if (TryFormatXml())
        {
            EnabledOptions.Add(XmlFormat);
        }
        else
        {
            FormattedText = Content.Text;
            FormatKind = PlaintextFormat;
        }
    }

    private string GetLogContentClass()
    {
        return $"log-content highlight-line language-{FormatKind} theme-a11y-{ThemeManager.EffectiveTheme?.ToLower()}-min";
    }

    private ICollection<StringLogLine> GetLines()
    {
        var lines = FormattedText.Split(["\r\n", "\r", "\n"], StringSplitOptions.None).ToList();

        return lines.Select((line, index) => new StringLogLine(index, line, FormatKind != PlaintextFormat)).ToList();
    }

    private bool TryFormatXml()
    {
        try
        {
            FormattedText = XDocument.Parse(Content.Text).ToString();
            FormatKind = XmlFormat;
            return true;
        }
        catch (XmlException)
        {
            return false;
        }
    }

    private bool TryFormatJson()
    {
        try
        {
            var formattedJson = FormatJson(Content.Text);

            FormattedText = formattedJson;
            FormatKind = JsonFormat;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private void OnFormatOptionChanged(MenuChangeEventArgs args) => ChangeFormat(args.Id);

    public void ChangeFormat(string? newFormat)
    {
        if (newFormat == XmlFormat)
        {
            TryFormatXml();
        }
        else if (newFormat == JsonFormat)
        {
            TryFormatJson();
        }
        else
        {
            FormattedText = Content.Text;
            FormatKind = PlaintextFormat;
        }
    }

    public static string FormatJson(string jsonString)
    {
        var jsonData = Encoding.UTF8.GetBytes(jsonString);

        // Initialize the Utf8JsonReader
        var reader = new Utf8JsonReader(jsonData, new JsonReaderOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Allow,
            // Increase the allowed limit to 1000. This matches the allowed limit of the writer.
            // It's ok to allow recursion here because JSON is read in a flat loop. There isn't a danger
            // of recursive method calls that cause a stack overflow.
            MaxDepth = 1000
        });

        // Use a MemoryStream and Utf8JsonWriter to write the formatted JSON
        using var stream = new MemoryStream();
        using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true });

        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    writer.WriteStartObject();
                    break;
                case JsonTokenType.EndObject:
                    writer.WriteEndObject();
                    break;
                case JsonTokenType.StartArray:
                    writer.WriteStartArray();
                    break;
                case JsonTokenType.EndArray:
                    writer.WriteEndArray();
                    break;
                case JsonTokenType.PropertyName:
                    writer.WritePropertyName(reader.GetString()!);
                    break;
                case JsonTokenType.String:
                    writer.WriteStringValue(reader.GetString());
                    break;
                case JsonTokenType.Number:
                    if (reader.TryGetInt32(out var intValue))
                    {
                        writer.WriteNumberValue(intValue);
                    }
                    else if (reader.TryGetDouble(out var doubleValue))
                    {
                        writer.WriteNumberValue(doubleValue);
                    }
                    break;
                case JsonTokenType.True:
                    writer.WriteBooleanValue(true);
                    break;
                case JsonTokenType.False:
                    writer.WriteBooleanValue(false);
                    break;
                case JsonTokenType.Null:
                    writer.WriteNullValue();
                    break;
                case JsonTokenType.Comment:
                    writer.WriteCommentValue(reader.GetComment());
                    break;
            }
        }

        writer.Flush();
        var formattedJson = Encoding.UTF8.GetString(stream.ToArray());

        return formattedJson;
    }

    public async ValueTask DisposeAsync()
    {
        if (_jsModule != null)
        {
            try
            {
                await _jsModule.InvokeVoidAsync("disconnectObserver");
                await _jsModule.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // Per https://learn.microsoft.com/aspnet/core/blazor/javascript-interoperability/?view=aspnetcore-7.0#javascript-interop-calls-without-a-circuit
                // this is one of the calls that will fail if the circuit is disconnected, and we just need to catch the exception so it doesn't pollute the logs
            }
        }
    }

    private record StringLogLine(int LineNumber, string Content, bool IsFormatted);
}


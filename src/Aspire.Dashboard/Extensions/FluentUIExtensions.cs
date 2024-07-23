// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Dashboard.Extensions;

internal static class FluentUIExtensions
{
    public static Dictionary<string, object> GetClipboardCopyAdditionalAttributes(string? text, string? precopy, string? postcopy, params (string Attribute, object Value)[] additionalAttributes)
    {
        // No onclick attribute is added here. The CSP restricts inline scripts, including onclick.
        // Instead, a click event listener is added to the document and clicking the button is bubbled up to the event.
        // The document click listener looks for a button element and these attributes.
        var attributes = new Dictionary<string, object>(AttributeKeyComparer.Instance)
        {
            { "data-text", text ?? string.Empty },
            { "data-precopy", precopy ?? string.Empty },
            { "data-postcopy", postcopy ?? string.Empty },
            { "data-copybutton", "true" }
        };

        foreach (var (attribute, value) in additionalAttributes)
        {
            attributes.Add(attribute, value);
        }

        return attributes;
    }

    public static Dictionary<string, object> GetOpenTextVisualizerAdditionalAttributes(string textValue, string textValueDescription, params (string Attribute, object Value)[] additionalAttributes)
    {
        var attributes = new Dictionary<string, object>(AttributeKeyComparer.Instance)
        {
            { "data-textvisualizer-text", textValue },
            { "data-textvisualizer-description", textValueDescription }
        };

        foreach (var (attribute, value) in additionalAttributes)
        {
            attributes.Add(attribute, value);
        }

        return attributes;
    }

    private class AttributeKeyComparer : IEqualityComparer<string>
    {
        public static readonly AttributeKeyComparer Instance = new();

        public bool Equals(string? x, string? y) => string.Equals(x, y, StringComparison.Ordinal);

        public int GetHashCode(string obj) => 31 * obj.GetHashCode();
    }
}

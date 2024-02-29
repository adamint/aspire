namespace Aspire.Dashboard.Components.Controls.NestedDataGrid;

public abstract class FluentNestedDataItem<T>(IReadOnlyCollection<T>? children) where T : FluentNestedDataItem<T>
{
	public IReadOnlyCollection<T>? Children { get; } = children;
	public bool IsExpandable { get; } = children?.Count > 0;
	public bool IsExpanded { get; set; } = children is null || children.Count == 0;
}

public record FluentNestedDataGridDisplayItem<T>(T Item, ICollection<FluentNestedDataItem<T>> Parents) where T : FluentNestedDataItem<T>
{
	public IReadOnlyCollection<T>? Children => Item.Children;
	public bool IsVisible => Parents.Count == 0 || Parents.All(parent => parent is { IsExpandable: true, IsExpanded: true });
}

using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Aspire.Dashboard.Components.Controls.NestedDataGrid;

[CascadingTypeParameter(nameof(TGridItem))]
public partial class FluentNestedDataGrid<TModelItem, TGridItem>
	where TModelItem : FluentNestedDataItem<TModelItem>
	where TGridItem : FluentNestedDataGridDisplayItem<TModelItem>
{
	[Parameter] public RenderFragment? ChildContent { get; set; }
	[Inject] public required IJSRuntime JS { get; set; }

	private static IEnumerable<TGridItem> GetGridItems(IEnumerable<TModelItem> items)
	{
		return GetGridItemsFor(items, []);

		static IEnumerable<TGridItem> GetGridItemsFor(IEnumerable<TModelItem> items, ICollection<FluentNestedDataItem<TModelItem>> parents)
		{
			foreach (var item in items)
			{
				yield return (TGridItem)new FluentNestedDataGridDisplayItem<TModelItem>(item, parents);

				if (item.Children is not null)
				{
					var newParents = parents.ToList();
					newParents.Add((FluentNestedDataItem<TModelItem>)item);

					foreach (var grandChild in GetGridItemsFor(item.Children, newParents))
					{
						yield return grandChild;
					}
				}
			}
		}
	}

	private string GetGridTemplateColumnsWithNestedColumns(IEnumerable<TGridItem> gridItems, int hierarchyLevels)
	{
		return string.Join(" ", Enumerable.Range(0, hierarchyLevels).Select(level => GetColumnWidthAtLevel?.Invoke(level, GetGridItemsAtLevel(gridItems, level)) ?? "0.45fr")) + " " + GridTemplateColumns;
	}

	private async Task ToggleNodeAsync(TGridItem item, string buttonId)
	{
		item.Item.IsExpanded = !item.Item.IsExpanded;
		await InvokeAsync(StateHasChanged);
	}

	private IEnumerable<TGridItem> GetGridItemsAtLevel(IEnumerable<TGridItem> gridItems, int level)
	{
		return gridItems.Where(item => item.Parents.Count == level);
	}
}

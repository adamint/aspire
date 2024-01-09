// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Model;
using Aspire.Dashboard.Otlp.Model.MetricValues;
using Microsoft.AspNetCore.Components;
using Microsoft.FluentUI.AspNetCore.Components;

namespace Aspire.Dashboard.Components;

public partial class MetricTable : ComponentBase
{
    private readonly SortedList<DimensionalMetric, DimensionalMetric> _metrics = new(DimensionalMetric.Comparer);
    private readonly GridSort<DimensionalMetric> _startSort = GridSort<DimensionalMetric>.ByAscending(m => m.Value.Start);
    private readonly GridSort<DimensionalMetric> _endSort = GridSort<DimensionalMetric>.ByAscending(m => m.Value.End);
    private readonly GridSort<DimensionalMetric> _countSort = GridSort<DimensionalMetric>.ByAscending(m => m.Value.Count);

    private bool _showLatestMetrics = true;
    public IEnumerable<DimensionalMetric> _filteredMetrics => _showLatestMetrics ? _metrics.Values.TakeLast(10) : _metrics.Values;

    protected override void OnInitialized()
    {
        InstrumentViewModel.DataUpdateSubscriptions.Add(OnInstrumentDataUpdate);
    }

    private async Task OnInstrumentDataUpdate()
    {
        _metrics.Clear();

        if (InstrumentViewModel.MatchedDimensions is not null)
        {
            var metricsWithDimension = InstrumentViewModel.MatchedDimensions.SelectMany(dimension =>
            {
                return dimension.Values.Select(value => new DimensionalMetric(dimension.Name, value));
            });

            foreach (var metric in metricsWithDimension)
            {
                _metrics[metric] = metric;
            }
        }

        await InvokeAsync(StateHasChanged);
    }

    public sealed record DimensionalMetric(string Dimension, MetricValueBase Value)
    {
        public static readonly MetricTimeComparer Comparer = new();
    }

    public class MetricTimeComparer : IComparer<DimensionalMetric>
    {
        public int Compare(DimensionalMetric? x, DimensionalMetric? y)
        {
            var result = x!.Value.Start.CompareTo(y!.Value.Start);
            return result is not 0 ? result : x.Value.End.CompareTo(y.Value.End);
        }
    }

    private void ToggleFilter()
    {
        StateHasChanged();
    }
}

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Model;
using Aspire.Dashboard.Otlp.Model.MetricValues;
using Microsoft.AspNetCore.Components;

namespace Aspire.Dashboard.Components;

public partial class MetricTable : ComponentBase
{
    private readonly SortedList<DimensionalMetric, DimensionalMetric> _metrics = new(DimensionalMetric.Comparer);

    private bool _showLatestMetrics = true;
    private bool _onlyShowValueChanges;

    private IEnumerable<DimensionalMetric> FilteredMetrics => _showLatestMetrics ? _metrics.Values.TakeLast(10) : _metrics.Values;
    private bool _anyDimensionsShown;

    protected override void OnInitialized()
    {
        InstrumentViewModel.DataUpdateSubscriptions.Add(OnInstrumentDataUpdate);
    }

    private async Task OnInstrumentDataUpdate()
    {
        _anyDimensionsShown = false;

        if (InstrumentViewModel.MatchedDimensions is not null)
        {
            var metricsWithDimension = new List<DimensionalMetric>();
            foreach (var dimension in InstrumentViewModel.MatchedDimensions)
            {
                if (!dimension.Name.Equals(DimensionScope.NoDimensions))
                {
                    _anyDimensionsShown = true;
                }

                for (var i = 0; i < dimension.Values.Count; i++)
                {
                    var metricValue = dimension.Values[i];
                    ValueDirectionChange? directionChange = ValueDirectionChange.Constant;
                    if (i > 0)
                    {
                        var previousValue = dimension.Values[i - 1];

                        if (metricValue.Count > previousValue.Count)
                        {
                            directionChange = ValueDirectionChange.Up;
                        }
                        else if (metricValue.Count < previousValue.Count)
                        {
                            directionChange = ValueDirectionChange.Down;
                        }
                    }

                    metricsWithDimension.Add(new DimensionalMetric(dimension.Name, dimension.Attributes, metricValue, directionChange));
                }
            }
            if (_onlyShowValueChanges && metricsWithDimension.Count > 0)
            {
                var current = metricsWithDimension[0].Value.Count;
                for (var i = 1; i < metricsWithDimension.Count; i++)
                {
                    var metric = metricsWithDimension[i].Value.Count;
                    if (current == metric)
                    {
                        metricsWithDimension.RemoveAt(i);
                        i--;
                    }
                    else
                    {
                        current = metric;
                    }
                }
            }

            while (_metrics.Count > metricsWithDimension.Count)
            {
                _metrics.RemoveAt(_metrics.Count - 1);
            }

            for (var i = 0; i < metricsWithDimension.Count; i++)
            {
                if (i >= _metrics.Count)
                {
                    _metrics.Add(metricsWithDimension[i], metricsWithDimension[i]);
                }
                else if (!_metrics.GetValueAtIndex(i).Equals(metricsWithDimension[i]))
                {
                    _metrics.SetValueAtIndex(i, metricsWithDimension[i]);
                }
            }
        }

        await InvokeAsync(StateHasChanged);
    }

    public sealed record DimensionalMetric(string DimensionName, KeyValuePair<string, string>[] DimensionAttributes, MetricValueBase Value, ValueDirectionChange? Direction)
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

    public enum ValueDirectionChange
    {
        Up,
        Down,
        Constant
    }

    private void ToggleFilter() => StateHasChanged();
    private void ToggleOnlyShowValueChanges() => StateHasChanged();
}

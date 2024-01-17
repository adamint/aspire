// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Dashboard.Model;
using Aspire.Dashboard.Otlp.Model;
using Aspire.Dashboard.Otlp.Model.MetricValues;
using Microsoft.AspNetCore.Components;
using CollectionExtensions = Aspire.Dashboard.Extensions.CollectionExtensions;

namespace Aspire.Dashboard.Components;

public partial class MetricTable : ComponentBase
{
    private readonly SortedList<Metric, Metric> _metrics = new(new MetricTimeComparer());

    private bool _showLatestMetrics = true;
    private bool _onlyShowValueChanges;

    private IEnumerable<Metric> FilteredMetrics => _showLatestMetrics ? _metrics.Values.TakeLast(10) : _metrics.Values;
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
            var metricsWithDimension = new List<Metric>();
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

                    if (metricValue is HistogramValue histogramValue)
                    {
                        var percentiles = new SortedDictionary<int, (double Value, ValueDirectionChange Direction)>();
                        foreach (var p in new List<int> { 50, 90, 99 })
                        {
                            var percentile = CalculatePercentile(p, histogramValue);
                            var directionChange = metricsWithDimension.LastOrDefault() is { } last ? GetDirectionChange(, ((HistogramValue)last)) : ValueDirectionChange.Constant;
                            percentiles.Add(p, (CalculatePercentile(p, histogramValue, )));
                        }


                        metricsWithDimension.Add(
                            new HistogramMetric
                            {
                                DimensionName = dimension.Name,
                                DimensionAttributes = dimension.Attributes,
                                Value = metricValue,
                                Direction = directionChange,
                                Percentiles =
                            });

                        ValueDirectionChange GetDirectionChange(double? current, double? previous)
                        {
                            if (current > previous)
                            {
                                return ValueDirectionChange.Up;
                            }

                            return previous < current ? ValueDirectionChange.Down : ValueDirectionChange.Constant;
                        }
                    }
                    else
                    {
                        metricsWithDimension.Add(
                            new Metric
                            {
                                DimensionName = dimension.Name,
                                DimensionAttributes = dimension.Attributes,
                                Value = metricValue,
                                Direction = directionChange
                            });
                    }
                }
            }
            if (_onlyShowValueChanges && metricsWithDimension.Count > 0)
            {
                if (InstrumentViewModel.Instrument?.Type != OtlpInstrumentType.Histogram || InstrumentViewModel.ShowCount)
                {
                    var current = metricsWithDimension[0].Value.Count;
                    for (var i = 1; i < metricsWithDimension.Count; i++)
                    {
                        var count = metricsWithDimension[i].Value.Count;
                        if (current == count)
                        {
                            metricsWithDimension.RemoveAt(i);
                            i--;
                        }
                        else
                        {
                            current = count;
                        }
                    }
                }
                else
                {
                    var currentPercentiles = CalculatePercentiles((HistogramValue)metricsWithDimension[0].Value);
                    for (var i = 1; i < metricsWithDimension.Count; i++)
                    {
                        var histogramValue = (HistogramValue)metricsWithDimension[0].Value;
                        var percentiles = CalculatePercentiles(histogramValue);
                        if (CollectionExtensions.Equivalent(currentPercentiles, percentiles))
                        {
                            metricsWithDimension.RemoveAt(i);
                            i--;
                        }
                        else
                        {
                            currentPercentiles = percentiles;
                        }
                    }

                    static double?[] CalculatePercentiles(HistogramValue value)
                    {
                        return [CalculatePercentile(50, value), CalculatePercentile(90, value), CalculatePercentile(99, value)];
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
                    _metrics.TryAdd(metricsWithDimension[i], metricsWithDimension[i]);
                }
                else if (!_metrics.GetValueAtIndex(i).Equals(metricsWithDimension[i]))
                {
                    _metrics.SetValueAtIndex(i, metricsWithDimension[i]);
                }
            }
        }

        await InvokeAsync(StateHasChanged);
    }

    private static double? CalculatePercentile(int percentile, HistogramValue value)
    {
        return PlotlyChart.CalculatePercentile(percentile, value.Values, value.ExplicitBounds);
    }

    public class Metric
    {
        public required string DimensionName { get; init; }
        public required KeyValuePair<string, string>[] DimensionAttributes { get; init; }
        public required MetricValueBase Value { get; init; }
        public required ValueDirectionChange? Direction { get; init; }
    }

    public class HistogramMetric : Metric
    {
        public required Dictionary<int, (double Value, ValueDirectionChange Direction)> Percentiles { get; init; }
    }

    public class MetricTimeComparer : IComparer<Metric>
    {
        public int Compare(Metric? x, Metric? y)
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

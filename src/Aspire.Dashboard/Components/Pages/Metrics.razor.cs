// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using Aspire.Dashboard.Extensions;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Model.Otlp;
using Aspire.Dashboard.Otlp.Model;
using Aspire.Dashboard.Otlp.Storage;
using Microsoft.AspNetCore.Components;
using Microsoft.FluentUI.AspNetCore.Components;

namespace Aspire.Dashboard.Components.Pages;

public partial class Metrics : IDisposable, IStatefulPage<Metrics.MetricsViewModel>
{
    private static readonly SelectViewModel<string> s_selectApplication = new SelectViewModel<string> { Id = null, Name = "(Select a resource)" };
    private List<SelectViewModel<TimeSpan>> _durations = null!;
    private static readonly TimeSpan s_defaultDuration = TimeSpan.FromMinutes(5);

    private List<SelectViewModel<string>> _applications = default!;
    private Subscription? _applicationsSubscription;
    private Subscription? _metricsSubscription;
    private List<OtlpInstrument>? _instruments;

    private MetricsViewModel ViewModel { get; set; } = null!;

    [Parameter]
    public string? ApplicationInstanceId { get; set; }

    [Parameter]
    public string? MeterName { get; set; }

    [Parameter]
    public string? InstrumentName { get; set; }

    [Parameter]
    [SupplyParameterFromQuery(Name = "duration")]
    public int DurationMinutes { get; set; }

    [Inject]
    public required NavigationManager NavigationManager { get; set; }

    [Inject]
    public required IResourceService ResourceService { get; set; }

    [Inject]
    public required TelemetryRepository TelemetryRepository { get; set; }

    [Inject]
    public required TracesRepository TracesRepository { get; set; }

    protected override Task OnInitializedAsync()
    {
        _durations = new List<SelectViewModel<TimeSpan>>
        {
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastOneMinute], Id = TimeSpan.FromMinutes(1) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastFiveMinutes], Id = TimeSpan.FromMinutes(5) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastFifteenMinutes], Id = TimeSpan.FromMinutes(15) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastThirtyMinutes], Id = TimeSpan.FromMinutes(30) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastHour], Id = TimeSpan.FromHours(1) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastThreeHours], Id = TimeSpan.FromHours(3) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastSixHours], Id = TimeSpan.FromHours(6) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastTwelveHours], Id = TimeSpan.FromHours(12) },
            new() { Name = Loc[Dashboard.Resources.Metrics.MetricsLastTwentyFourHours], Id = TimeSpan.FromHours(24) },
        };

        UpdateApplications();
        _applicationsSubscription = TelemetryRepository.OnNewApplications(() => InvokeAsync(() =>
        {
            UpdateApplications();
            StateHasChanged();
        }));
        return Task.CompletedTask;
    }

    protected override void OnParametersSet()
    {
        ViewModel = GetViewModelFromQuery();
        UpdateSubscription();
    }

    public MetricsViewModel GetViewModelFromQuery()
    {
        var viewModel = new MetricsViewModel
        {
            SelectedDuration = _durations.SingleOrDefault(d => (int)d.Id.TotalMinutes == DurationMinutes) ?? _durations.Single(d => d.Id == s_defaultDuration),
            SelectedApplication = _applications.SingleOrDefault(e => e.Id == ApplicationInstanceId) ?? s_selectApplication,
            SelectedMeter = null,
            SelectedInstrument = null
        };

        TracesRepository.ApplicationServiceId = viewModel.SelectedApplication.Id;
        _instruments = !string.IsNullOrEmpty(viewModel.SelectedApplication.Id) ? TelemetryRepository.GetInstrumentsSummary(viewModel.SelectedApplication.Id) : null;

        if (_instruments != null && !string.IsNullOrEmpty(MeterName))
        {
            viewModel.SelectedMeter = _instruments.FirstOrDefault(i => i.Parent.MeterName == MeterName)?.Parent;
            if (viewModel.SelectedMeter != null && !string.IsNullOrEmpty(InstrumentName))
            {
                viewModel.SelectedInstrument = TelemetryRepository.GetInstrument(new GetInstrumentRequest
                {
                    ApplicationServiceId = ApplicationInstanceId!,
                    MeterName = MeterName,
                    InstrumentName = InstrumentName
                });
            }
        }

        return viewModel;
    }

    private void UpdateApplications()
    {
        _applications = SelectViewModelFactory.CreateApplicationsSelectViewModel(TelemetryRepository.GetApplications());
        _applications.Insert(0, s_selectApplication);
        UpdateSubscription();
    }

    private void HandleSelectedApplicationChanged()
    {
        this.AfterViewModelChanged();
    }

    private void HandleSelectedDurationChanged()
    {
        this.AfterViewModelChanged();
    }

    public sealed class MetricsViewModel
    {
        public FluentTreeItem? SelectedTreeItem { get; set; }
        public OtlpMeter? SelectedMeter { get; set; }
        public OtlpInstrument? SelectedInstrument { get; set; }
        public SelectViewModel<string> SelectedApplication = s_selectApplication;
        public SelectViewModel<TimeSpan> SelectedDuration { get; set; } = null!;
    }

    private void HandleSelectedTreeItemChanged()
    {
        if (ViewModel.SelectedTreeItem?.Data is OtlpMeter meter)
        {
            ViewModel.SelectedMeter = meter;
            ViewModel.SelectedInstrument = null;
        }
        else if (ViewModel.SelectedTreeItem?.Data is OtlpInstrument instrument)
        {
            ViewModel.SelectedMeter = instrument.Parent;
            ViewModel.SelectedInstrument = instrument;
        }
        else
        {
            ViewModel.SelectedMeter = null;
            ViewModel.SelectedInstrument = null;
        }

        this.AfterViewModelChanged();
    }

    public (string Path, Dictionary<string, string?> QueryParameters) GetUriFromViewModel()
    {
        string path;
        if (ViewModel.SelectedMeter is not null)
        {
            if (ViewModel.SelectedInstrument != null)
            {
                path = $"/Metrics/{ViewModel.SelectedApplication.Id}/Meter/{ViewModel.SelectedMeter.MeterName}/Instrument/{ViewModel.SelectedInstrument.Name}";
            }
            else
            {
                path = $"/Metrics/{ViewModel.SelectedApplication.Id}/Meter/{ViewModel.SelectedMeter.MeterName}";
            }
        }
        else if (ViewModel.SelectedApplication.Id != null)
        {
            path = $"/Metrics/{ViewModel.SelectedApplication.Id}";
        }
        else
        {
            path = $"/Metrics";
        }

        var queryParameters = new Dictionary<string, string?>();

        if (ViewModel.SelectedDuration.Id != s_defaultDuration)
        {
            queryParameters.Add("duration", ((int)ViewModel.SelectedDuration.Id.TotalMinutes).ToString(CultureInfo.InvariantCulture));
        }

        return (path, queryParameters);
    }

    private void UpdateSubscription()
    {
        var selectedApplication = (ViewModel?.SelectedApplication ?? s_selectApplication).Id;
        // Subscribe to updates.
        if (_metricsSubscription is null || _metricsSubscription.ApplicationId != selectedApplication)
        {
            _metricsSubscription?.Dispose();
            _metricsSubscription = TelemetryRepository.OnNewMetrics(selectedApplication, SubscriptionType.Read, async () =>
            {
                if (!string.IsNullOrEmpty(selectedApplication))
                {
                    // If there are more instruments than before then update the UI.
                    var instruments = TelemetryRepository.GetInstrumentsSummary(selectedApplication);

                    if (_instruments is null || instruments.Count > _instruments.Count)
                    {
                        _instruments = instruments;
                        await InvokeAsync(StateHasChanged);
                    }
                }
            });
        }
    }

    public void Dispose()
    {
        _applicationsSubscription?.Dispose();
        _metricsSubscription?.Dispose();
    }
}

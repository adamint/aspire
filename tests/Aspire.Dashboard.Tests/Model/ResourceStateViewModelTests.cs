// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Globalization;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Resources;
using Aspire.Tests.Shared.DashboardModel;
using Google.Protobuf.WellKnownTypes;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Localization;
using Microsoft.FluentUI.AspNetCore.Components;
using Xunit;
using Enum = System.Enum;

namespace Aspire.Dashboard.Tests.Model;

public class ResourceStateViewModelTests
{
    [Theory]
    // Resource is no longer running
    [InlineData(
        /* state */ "Container", KnownResourceState.Exited, null, null,null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceExited)}:Container", "RecordStop", Color.Info, "Exited")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Exited, 3, null, null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceExitedUnexpectedly)}:Container+3", "ErrorCircle", Color.Error, "Exited")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Exited, 0, null, null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceExited)}:Container", "RecordStop", Color.Info, "Exited")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Finished, 0, null, null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceExited)}:Container", "RecordStop", Color.Info, "Finished")]
    [InlineData(
        /* state */ "CustomResource", KnownResourceState.Finished, null, null, null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceExited)}:CustomResource", "RecordStop", Color.Info, "Finished")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Unknown, null, null, null,
        /* expected output */ null, "CircleHint", Color.Info, "Unknown")]
    // Health checks
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, "Healthy", null,
        /* expected output */ null, "CheckmarkCircle", Color.Success, "Running")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, "", null,
        /* expected output */ $"Localized:{nameof(Columns.RunningAndUnhealthyResourceStateToolTip)}", "CheckmarkCircleWarning", Color.Warning, "Running (Unhealthy)")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, "Unhealthy", null,
        /* expected output */ $"Localized:{nameof(Columns.RunningAndUnhealthyResourceStateToolTip)}", "CheckmarkCircleWarning", Color.Warning, "Running (Unhealthy)")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, "Healthy", "warning",
        /* expected output */ null, "Warning", Color.Warning, "Running")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, "Healthy", "NOT_A_VALID_STATE_STYLE",
        /* expected output */ null, "Circle", Color.Neutral, "Running")]
    [InlineData(
        /* state */ "Container", KnownResourceState.Running, null, null, "info",
        /* expected output */ null, "Info", Color.Info, "Running")]
    [InlineData(
        /* state */ "Container", KnownResourceState.RuntimeUnhealthy, null, null, null,
        /* expected output */ $"Localized:{nameof(Columns.StateColumnResourceContainerRuntimeUnhealthy)}", "Warning", Color.Warning, "Runtime unhealthy")]
    public void ResourceViewModel_ReturnsCorrectIconAndTooltip(
        string resourceType,
        KnownResourceState state,
        int? exitCode,
        string? healthStatusString,
        string? stateStyle,
        string? expectedTooltip,
        string expectedIconName,
        Color expectedColor,
        string expectedText)
    {
        // Arrange
        HealthStatus? healthStatus = string.IsNullOrEmpty(healthStatusString) ? null : Enum.Parse<HealthStatus>(healthStatusString);
        var propertiesDictionary = new Dictionary<string, ResourcePropertyViewModel>();
        if (exitCode is not null)
        {
            propertiesDictionary.TryAdd(KnownProperties.Resource.ExitCode, new ResourcePropertyViewModel(KnownProperties.Resource.ExitCode, Value.ForNumber((double)exitCode), false, null, 0));
        }

        var resource = ModelTestHelpers.CreateResource(
            state: state,
            reportHealthStatus: healthStatus,
            createNullHealthReport: healthStatusString == "",
            stateStyle: stateStyle,
            resourceType: resourceType,
            properties: propertiesDictionary);

        if (exitCode is not null)
        {
            resource.Properties.TryAdd(KnownProperties.Resource.ExitCode, new ResourcePropertyViewModel(KnownProperties.Resource.ExitCode, Value.ForNumber((double)exitCode), false, null, 0));
        }

        var localizer = new TestStringLocalizer<Columns>();

        // Act
        var tooltip = ResourceStateViewModel.GetResourceStateTooltip(resource, localizer);
        var vm = ResourceStateViewModel.GetStateViewModel(resource, localizer);

        // Assert
        Assert.Equal(expectedTooltip, tooltip);

        Assert.Equal(expectedIconName, vm.Icon.Name);
        Assert.Equal(expectedColor, vm.Color);
        Assert.Equal(expectedText, vm.Text);
    }

    [Fact]
    public void GetResourceStateTooltip_ExitedCustomResource_EncodesResourceType()
    {
        var resource = ModelTestHelpers.CreateResource(
            state: KnownResourceState.Exited,
            resourceType: "<marquee>An HTML resource type!</marquee>");

        var tooltip = ResourceStateViewModel.GetResourceStateTooltip(resource, new HtmlTestStringLocalizer());

        Assert.Equal("&lt;marquee&gt;An HTML resource type!&lt;/marquee&gt; is no longer running", tooltip);
    }

    [Fact]
    public void GetResourceStateTooltip_RuntimeUnhealthyContainer_PreservesLocalizedMarkup()
    {
        var resource = ModelTestHelpers.CreateResource(state: KnownResourceState.RuntimeUnhealthy);

        var tooltip = ResourceStateViewModel.GetResourceStateTooltip(resource, new HtmlTestStringLocalizer());

        Assert.Contains("<a href=\"https://aka.ms/dotnet/aspire/container-runtime-unhealthy\"", tooltip);
    }

    private sealed class HtmlTestStringLocalizer : IStringLocalizer<Columns>
    {
        public LocalizedString this[string name]
        {
            get
            {
                return name switch
                {
                    nameof(Columns.StateColumnResourceContainerRuntimeUnhealthy) => new(name, "Container runtime issue. <a href=\"https://aka.ms/dotnet/aspire/container-runtime-unhealthy\">More information</a>."),
                    nameof(Columns.RunningAndUnhealthyResourceStateToolTip) => new(name, "Resource is running but not in a healthy state."),
                    nameof(Columns.StateColumnResourceWaiting) => new(name, "Resource is waiting for other resources to be in a running and healthy state."),
                    nameof(Columns.StateColumnResourceNotStarted) => new(name, "Resource has not started because it's configured to not automatically start."),
                    _ => new(name, name)
                };
            }
        }

        public LocalizedString this[string name, params object[] arguments]
        {
            get
            {
                var format = name switch
                {
                    nameof(Columns.StateColumnResourceExited) => "{0} is no longer running",
                    nameof(Columns.StateColumnResourceExitedUnexpectedly) => "{0} exited unexpectedly with exit code {1}",
                    _ => name
                };

                return new(name, string.Format(CultureInfo.CurrentCulture, format, arguments));
            }
        }

        public IEnumerable<LocalizedString> GetAllStrings(bool includeParentCultures) => [];
    }
}

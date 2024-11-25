// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Aspire.Dashboard.Model;
using FluentUIIconVariant = Microsoft.FluentUI.AspNetCore.Components.IconVariant;

namespace Aspire.ResourceService.Proto.V1;

partial class Resource
{
    /// <summary>
    /// Converts this gRPC message object to a view model for use in the dashboard UI.
    /// </summary>
    public ResourceViewModel ToViewModel(BrowserTimeProvider timeProvider, IKnownPropertyLookup knownPropertyLookup)
    {
        try
        {
            return new()
            {
                Name = ValidateNotNull(Name),
                ResourceType = ValidateNotNull(ResourceType),
                DisplayName = ValidateNotNull(DisplayName),
                Uid = ValidateNotNull(Uid),
                CreationTimeStamp = ValidateNotNull(CreatedAt).ToDateTime(),
                StartTimeStamp = StartedAt?.ToDateTime(),
                StopTimeStamp = StoppedAt?.ToDateTime(),
                Properties = Properties.ToImmutableDictionary(
                    keyComparer: StringComparers.ResourcePropertyName,
                    keySelector: property => ValidateNotNull(property.Name),
                    elementSelector: property =>
                    {
                        var (priority, knownProperty) = knownPropertyLookup.FindProperty(ResourceType, property.Name);

                        return new ResourcePropertyViewModel(
                            name: ValidateNotNull(property.Name),
                            value: ValidateNotNull(property.Value),
                            isValueSensitive: property.IsSensitive,
                            knownProperty: knownProperty,
                            priority: priority,
                            timeProvider: timeProvider);
                    }),
                Environment = GetEnvironment(),
                Urls = GetUrls(),
                Volumes = GetVolumes(),
                Relationships = GetRelationships(),
                State = HasState ? State : null,
                KnownState = HasState ? Enum.TryParse(State, out KnownResourceState knownState) ? knownState : null : null,
                StateStyle = HasStateStyle ? StateStyle : null,
                Commands = GetCommands(),
                HealthReports = HealthReports.Select(ToHealthReportViewModel).OrderBy(vm => vm.Name).ToImmutableArray(),
            };
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($@"Error converting resource ""{Name}"" to {nameof(ResourceViewModel)}.", ex);
        }

        HealthReportViewModel ToHealthReportViewModel(HealthReport healthReport)
        {
            return new HealthReportViewModel(healthReport.Key, healthReport.HasStatus ? MapHealthStatus(healthReport.Status) : null, healthReport.Description, healthReport.Exception);
        }

        Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus MapHealthStatus(HealthStatus healthStatus)
        {
            return healthStatus switch
            {
                HealthStatus.Healthy => Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Healthy,
                HealthStatus.Degraded => Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Degraded,
                HealthStatus.Unhealthy => Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Unhealthy,
                _ => throw new InvalidOperationException("Unknown health status: " + healthStatus),
            };
        }

        ImmutableArray<EnvironmentVariableViewModel> GetEnvironment()
        {
            return Environment
                .Select(e => new EnvironmentVariableViewModel(e.Name, e.Value, e.IsFromSpec))
                .ToImmutableArray();
        }

        ImmutableArray<RelationshipViewModel> GetRelationships()
        {
            return Relationships
                .Select(r => new RelationshipViewModel(r.ResourceName, r.Type))
                .ToImmutableArray();
        }

        ImmutableArray<UrlViewModel> GetUrls()
        {
            // Filter out bad urls
            return (from u in Urls
                    let parsedUri = Uri.TryCreate(u.FullUrl, UriKind.Absolute, out var uri) ? uri : null
                    where parsedUri != null
                    select new UrlViewModel(u.Name, parsedUri, u.IsInternal))
                    .ToImmutableArray();
        }

        ImmutableArray<VolumeViewModel> GetVolumes()
        {
            return Volumes
                .Select((v, i) => new VolumeViewModel(i, v.Source, v.Target, v.MountType, v.IsReadOnly))
                .ToImmutableArray();
        }

        ImmutableArray<CommandViewModel> GetCommands()
        {
            return Commands
                .Select(c => new CommandViewModel(c.Name, MapState(c.State), c.DisplayName, c.DisplayDescription, c.ConfirmationMessage, c.Parameter, c.IsHighlighted, c.IconName, MapIconVariant(c.IconVariant)))
                .ToImmutableArray();
            static CommandViewModelState MapState(ResourceCommandState state)
            {
                return state switch
                {
                    ResourceCommandState.Enabled => CommandViewModelState.Enabled,
                    ResourceCommandState.Disabled => CommandViewModelState.Disabled,
                    ResourceCommandState.Hidden => CommandViewModelState.Hidden,
                    _ => throw new InvalidOperationException("Unknown state: " + state),
                };
            }
            static FluentUIIconVariant MapIconVariant(IconVariant iconVariant)
            {
                return iconVariant switch
                {
                    IconVariant.Regular => FluentUIIconVariant.Regular,
                    IconVariant.Filled => FluentUIIconVariant.Filled,
                    _ => throw new InvalidOperationException("Unknown icon variant: " + iconVariant),
                };
            }
        }

        T ValidateNotNull<T>(T value, [CallerArgumentExpression(nameof(value))] string? expression = null) where T : class
        {
            if (value is null)
            {
                throw new InvalidOperationException($"Message field '{expression}' on resource with name '{Name}' cannot be null.");
            }

            return value;
        }
    }
}

partial class ResourceCommandResponse
{
    public ResourceCommandResponseViewModel ToViewModel()
    {
        return new ResourceCommandResponseViewModel()
        {
            ErrorMessage = ErrorMessage,
            Kind = (Dashboard.Model.ResourceCommandResponseKind)Kind
        };
    }
}

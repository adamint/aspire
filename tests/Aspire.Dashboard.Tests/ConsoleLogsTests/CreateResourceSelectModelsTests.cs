﻿// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using System.Collections.Frozen;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Model.Otlp;
using Aspire.Dashboard.Otlp.Model;
using Google.Protobuf.WellKnownTypes;
using Xunit;

namespace Aspire.Dashboard.Tests.ConsoleLogsTests;

public class CreateResourceSelectModelsTests
{
    [Fact]
    public void GetViewModels_ReturnsRightReplicas()
    {
        // Arrange
        var applications = new List<ResourceViewModel>
        {
            CreateResourceViewModel("App1-r1", KnownResourceState.Running, ("App1", "111")),
            CreateResourceViewModel("App1-r2", null, ("App1", "111")),
            CreateResourceViewModel("App1-r1-same-display-name", KnownResourceState.Running, null, displayName: "App1-r1"), // we could have apps with the same name but different / no owner,
            CreateResourceViewModel("App2", KnownResourceState.Starting, null),
            CreateResourceViewModel("App3", KnownResourceState.Finished, ("App3", "222")), // we won't show a grouping if there is only one app with an owner
            CreateResourceViewModel("App1-same-owner-name", KnownResourceState.Running, ("App1", "333")) // this should show up in its own grouping since its owner uid is different
        };

        var resourcesByName = new ConcurrentDictionary<string, ResourceViewModel>(applications.ToDictionary(app => app.Name));

        var unknownStateText = "unknown-state";
        var selectAResourceText = "select-a-resource";
        var noSelectionViewModel = new SelectViewModel<ResourceTypeDetails> { Id = null, Name = selectAResourceText };

        // Act
        var viewModels = Components.Pages.ConsoleLogs.GetConsoleLogResourceSelectViewModels(resourcesByName, noSelectionViewModel, unknownStateText);

        // Assert
        Assert.Collection(viewModels,
            entry =>
            {
                Assert.Equal(entry, noSelectionViewModel);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.ApplicationGrouping, entry.Id.Type);
                Assert.Null(entry.Id.InstanceId);
                Assert.Equal("App1", entry.Id.ReplicaSetName);

                Assert.Equal("App1", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.ReplicaInstance, entry.Id.Type);
                Assert.Equal("App1-r1", entry.Id.InstanceId);
                Assert.Equal("App1", entry.Id.ReplicaSetName);

                Assert.Equal("App1-r1", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.ReplicaInstance, entry.Id.Type);
                Assert.Equal("App1-r2", entry.Id.InstanceId);
                Assert.Equal("App1", entry.Id.ReplicaSetName);

                Assert.Equal($"App1-r2 ({unknownStateText})", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.Singleton, entry.Id.Type);
                Assert.Equal("App1-r1-same-display-name", entry.Id.InstanceId);

                Assert.Equal("App1-r1", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.Singleton, entry.Id.Type);
                Assert.Equal("App1-same-owner-name", entry.Id.InstanceId);

                Assert.Equal("App1-same-owner-name", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.Singleton, entry.Id.Type);
                Assert.Equal("App2", entry.Id.InstanceId);

                Assert.Equal("App2 (Starting)", entry.Name);
            },
            entry =>
            {
                Assert.NotNull(entry.Id);
                Assert.Equal(OtlpApplicationType.Singleton, entry.Id.Type);
                Assert.Equal("App3", entry.Id.InstanceId);

                Assert.Equal("App3 (Finished)", entry.Name);
            }
            );
    }

    private static ResourceViewModel CreateResourceViewModel(string appName, KnownResourceState? state, (string OwnerName, string OwnerUid)? owner, string? displayName = null)
    {
        return new ResourceViewModel
        {
            Name = appName,
            ResourceType = "CustomResource",
            DisplayName = displayName ?? appName,
            Uid = Guid.NewGuid().ToString(),
            CreationTimeStamp = DateTime.UtcNow,
            Environment = [],
            Properties = FrozenDictionary<string, Value>.Empty,
            Urls = [],
            State = state?.ToString(),
            KnownState = state,
            StateStyle = null,
            Commands = [],
            Owners = owner is not null ? [new OwnerViewModel(KnownOwnerProperties.ExecutableReplicaSetKind, owner.Value.OwnerName, owner.Value.OwnerUid)] : []
        };
    }
}

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Aspire.Cli.Backchannel;
using Aspire.Cli.Tests.TestServices;
using Microsoft.Extensions.Time.Testing;

namespace Aspire.Cli.Tests.Backchannel;

public class ResourceWaitServiceTests
{
    [Theory]
    [InlineData("healthy")]
    [InlineData("up")]
    [InlineData("down")]
    public async Task WaitAsync_MapsTargetsAndSuccessfulResponse(string expectedStatus)
    {
        var timeProvider = new FakeTimeProvider();
        var target = expectedStatus switch
        {
            "healthy" => ResourceWaitTarget.Healthy,
            "up" => ResourceWaitTarget.Up,
            "down" => ResourceWaitTarget.Down,
            _ => throw new ArgumentOutOfRangeException(nameof(expectedStatus))
        };
        string? actualResourceName = null;
        string? actualStatus = null;
        int? actualTimeoutSeconds = null;
        var backchannel = new TestAppHostAuxiliaryBackchannel
        {
            WaitForResourceHandler = (resourceName, status, timeoutSeconds, _) =>
            {
                actualResourceName = resourceName;
                actualStatus = status;
                actualTimeoutSeconds = timeoutSeconds;
                timeProvider.Advance(TimeSpan.FromMilliseconds(1250));
                return Task.FromResult(new WaitForResourceResponse
                {
                    Success = true,
                    State = "Running",
                    HealthStatus = "Healthy"
                });
            }
        };
        var service = new ResourceWaitService(timeProvider);

        var result = await service.WaitAsync(
            backchannel,
            "api",
            target,
            timeoutSeconds: 30,
            TestContext.Current.CancellationToken);

        Assert.Equal("api", actualResourceName);
        Assert.Equal(expectedStatus, actualStatus);
        Assert.Equal(30, actualTimeoutSeconds);
        Assert.Equal(ResourceWaitOutcome.Success, result.Outcome);
        Assert.Equal("api", result.ResourceName);
        Assert.Equal("Running", result.State);
        Assert.False(result.ResourceNotFound);
        Assert.Null(result.ErrorMessage);
        Assert.Equal(TimeSpan.FromMilliseconds(1250), result.Elapsed);
    }

    [Fact]
    public async Task WaitAsync_TreatsFailedToStartAsFailureForDownTarget()
    {
        var timeProvider = new FakeTimeProvider();
        var backchannel = new TestAppHostAuxiliaryBackchannel
        {
            WaitForResourceHandler = (_, _, _, _) => Task.FromResult(new WaitForResourceResponse
            {
                Success = true,
                State = "FailedToStart"
            })
        };
        var service = new ResourceWaitService(timeProvider);

        var result = await service.WaitAsync(
            backchannel,
            "api",
            ResourceWaitTarget.Down,
            timeoutSeconds: 30,
            TestContext.Current.CancellationToken);

        Assert.Equal(ResourceWaitOutcome.Failure, result.Outcome);
        Assert.Equal("FailedToStart", result.State);
    }

    [Theory]
    [InlineData(true, false, "Failure")]
    [InlineData(false, true, "Timeout")]
    [InlineData(false, false, "Failure")]
    public async Task WaitAsync_MapsUnsuccessfulResponses(
        bool resourceNotFound,
        bool timedOut,
        string expectedOutcomeName)
    {
        var timeProvider = new FakeTimeProvider();
        var backchannel = new TestAppHostAuxiliaryBackchannel
        {
            WaitForResourceHandler = (_, _, _, _) => Task.FromResult(new WaitForResourceResponse
            {
                Success = false,
                State = "Waiting",
                HealthStatus = "Unhealthy",
                ResourceNotFound = resourceNotFound,
                TimedOut = timedOut,
                ErrorMessage = "Wait failed."
            })
        };
        var service = new ResourceWaitService(timeProvider);

        var result = await service.WaitAsync(
            backchannel,
            "api",
            ResourceWaitTarget.Healthy,
            timeoutSeconds: 30,
            TestContext.Current.CancellationToken);

        Assert.Equal(Enum.Parse<ResourceWaitOutcome>(expectedOutcomeName), result.Outcome);
        Assert.Equal("api", result.ResourceName);
        Assert.Equal("Waiting", result.State);
        Assert.Equal(resourceNotFound, result.ResourceNotFound);
        Assert.Equal("Wait failed.", result.ErrorMessage);
    }
}

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Microsoft.Extensions.Time.Testing;

namespace Aspire.Cli.Tests.TestServices;

/// <summary>
/// Delegates to a <see cref="FakeTimeProvider"/> and signals when a timer is created for a
/// specific due time.
/// </summary>
/// <remarks>
/// Advancing a fake clock before the code under test has registered its timer is a lost-wakeup
/// race: the timer is then created already due in a future the test never reaches, so the waiter
/// blocks forever instead of failing. Awaiting <see cref="TimerCreated"/> before calling
/// <see cref="FakeTimeProvider.Advance"/> makes the ordering deterministic. Matching on the due
/// time keeps unrelated timers (for example a timeout <see cref="CancellationTokenSource"/>) from
/// releasing the wait early.
/// </remarks>
internal sealed class TimerObservingTimeProvider(FakeTimeProvider inner, TimeSpan observedDueTime) : TimeProvider
{
    private readonly TaskCompletionSource _timerCreated = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task TimerCreated => _timerCreated.Task;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = inner.CreateTimer(callback, state, dueTime, period);

        if (dueTime == observedDueTime)
        {
            _timerCreated.TrySetResult();
        }

        return timer;
    }

    public override DateTimeOffset GetUtcNow() => inner.GetUtcNow();

    public override long GetTimestamp() => inner.GetTimestamp();

    public override TimeZoneInfo LocalTimeZone => inner.LocalTimeZone;

    public override long TimestampFrequency => inner.TimestampFrequency;
}

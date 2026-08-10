// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections;
using Microsoft.Extensions.Logging;

namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// Gathers command line arguments for resources.
/// </summary>
internal class ArgumentsExecutionConfigurationGatherer : IExecutionConfigurationGatherer
{
    private readonly Func<CommandLineArgsCallbackAnnotation, bool> _shouldIncludeAnnotation;
    private readonly DebugCommandLineArgsRewriteCapture? _debugRewriteCapture;

    public ArgumentsExecutionConfigurationGatherer(
        Func<CommandLineArgsCallbackAnnotation, bool>? shouldIncludeAnnotation = null,
        DebugCommandLineArgsRewriteCapture? debugRewriteCapture = null)
    {
        _shouldIncludeAnnotation = shouldIncludeAnnotation ?? (static _ => true);
        _debugRewriteCapture = debugRewriteCapture;
    }

    /// <inheritdoc/>
    public async ValueTask GatherAsync(IExecutionConfigurationGathererContext context, IResource resource, ILogger resourceLogger, DistributedApplicationExecutionContext executionContext, CancellationToken cancellationToken = default)
    {
        if (resource.TryGetAnnotationsOfType<CommandLineArgsCallbackAnnotation>(out var argumentAnnotations))
        {
            IList<object> args = [.. context.Arguments];
            List<object>? executableArgs = null;

            foreach (var ann in argumentAnnotations)
            {
                if (_debugRewriteCapture is not null && ReferenceEquals(ann, _debugRewriteCapture.ActiveDebugArgsAnnotation))
                {
                    ann.AsCallbackAnnotation().ForgetCachedResult();
                    var (rewrittenArgs, _) = await EvaluateAsync(ann, [.. args], resource, resourceLogger, executionContext, cancellationToken).ConfigureAwait(false);
                    executableArgs = [.. rewrittenArgs];
                    continue;
                }

                if (!_shouldIncludeAnnotation(ann))
                {
                    continue;
                }

                if (executableArgs is null)
                {
                    // Each annotation receives the current arguments. This matters when an earlier
                    // annotation returns a cached immutable result instead of mutating the prior list.
                    (args, _) = await EvaluateAsync(ann, [.. args], resource, resourceLogger, executionContext, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    var mirroredArgs = new MirroredCommandLineArgs([.. args], executableArgs);
                    var (evaluatedArgs, callbackStarted) = await EvaluateAsync(ann, mirroredArgs, resource, resourceLogger, executionContext, cancellationToken).ConfigureAwait(false);
                    args = evaluatedArgs;
                    if (callbackStarted)
                    {
                        executableArgs = mirroredArgs.SecondaryArguments;
                        ann.SetCachedMirroredSecondaryOperations(mirroredArgs.SecondaryOperations);
                    }
                    else if (ann.TryGetCachedMirroredSecondaryOperations(out var cachedMirroredSecondaryOperations))
                    {
                        // CommandLineArgsCallbackAnnotation caches ordinary WithArgs results across replicas.
                        // The active debug rewrite above is intentionally fresh for each executable creation, so
                        // replay the later callback's mutation shape onto this executable's current debug branch
                        // instead of reusing the prior replica's concrete argument list.
                        executableArgs = [.. executableArgs];
                        foreach (var operation in cachedMirroredSecondaryOperations)
                        {
                            operation.Apply(executableArgs);
                        }
                    }
                    else
                    {
                        // This can only happen if the annotation was cached by an earlier non-debug path.
                        // Re-evaluate once with the mirrored list so the executable branch does not silently
                        // drop the later annotation.
                        ann.AsCallbackAnnotation().ForgetCachedResult();
                        (args, _) = await EvaluateAsync(ann, mirroredArgs, resource, resourceLogger, executionContext, cancellationToken).ConfigureAwait(false);
                        executableArgs = mirroredArgs.SecondaryArguments;
                        ann.SetCachedMirroredSecondaryOperations(mirroredArgs.SecondaryOperations);
                    }
                }
            }

            if (_debugRewriteCapture is { } debugRewriteCapture)
            {
                debugRewriteCapture.OriginalArguments = [.. args];
                debugRewriteCapture.ExecutableArguments = executableArgs ?? [.. args];
            }

            // Take the final result and apply to the gatherer context.
            context.Arguments.Clear();
            context.Arguments.AddRange(args);
        }
    }

    private static async Task<(IList<object> Args, bool CallbackStarted)> EvaluateAsync(
        CommandLineArgsCallbackAnnotation annotation,
        IList<object> args,
        IResource resource,
        ILogger resourceLogger,
        DistributedApplicationExecutionContext executionContext,
        CancellationToken cancellationToken)
    {
        var callbackContext = new CommandLineArgsCallbackContext(args, resource, cancellationToken)
        {
            Logger = resourceLogger,
            ExecutionContext = executionContext
        };

        var result = await annotation.EvaluateOnceAsync(callbackContext, out var callbackStarted).ConfigureAwait(false);
        return (result, callbackStarted);
    }
}

internal sealed class DebugCommandLineArgsRewriteCapture(CommandLineArgsCallbackAnnotation activeDebugArgsAnnotation)
{
    public CommandLineArgsCallbackAnnotation ActiveDebugArgsAnnotation { get; } = activeDebugArgsAnnotation;

    public IReadOnlyList<object> OriginalArguments { get; set; } = [];

    public IReadOnlyList<object> ExecutableArguments { get; set; } = [];
}

internal sealed class MirroredCommandLineArgs : IList<object>
{
    private readonly List<PrimaryArgument> _primaryArguments;
    private readonly List<SecondaryArgument> _secondaryArguments = [];
    private int _nextPrimaryId;

    public List<MirroredCommandLineArgsOperation> SecondaryOperations { get; } = [];

    public MirroredCommandLineArgs(IList<object> primaryArguments, IEnumerable<object> secondaryArguments)
    {
        _primaryArguments = new List<PrimaryArgument>(primaryArguments.Count);
        var primaryOccurrences = new Dictionary<object, Queue<PrimaryArgument>>(ReferenceEqualityComparer.Instance);

        foreach (var argument in primaryArguments)
        {
            var primaryArgument = new PrimaryArgument(_nextPrimaryId++, argument);
            _primaryArguments.Add(primaryArgument);

            if (!primaryOccurrences.TryGetValue(argument, out var occurrences))
            {
                occurrences = new Queue<PrimaryArgument>();
                primaryOccurrences[argument] = occurrences;
            }

            occurrences.Enqueue(primaryArgument);
        }

        foreach (var argument in secondaryArguments)
        {
            PrimaryArgument? primaryArgument = null;
            if (primaryOccurrences.TryGetValue(argument, out var occurrences) && occurrences.Count > 0)
            {
                primaryArgument = occurrences.Dequeue();
            }

            _secondaryArguments.Add(new SecondaryArgument(argument, primaryArgument?.Id));
        }
    }

    public List<object> SecondaryArguments => [.. _secondaryArguments.Select(static argument => argument.Value)];

    public object this[int index]
    {
        get => _primaryArguments[index].Value;
        set
        {
            var primaryArgument = _primaryArguments[index];
            primaryArgument.Value = value;

            var secondaryIndex = _secondaryArguments.FindIndex(argument => argument.PrimaryId == primaryArgument.Id);
            if (secondaryIndex < 0)
            {
                secondaryIndex = index;
            }

            if (secondaryIndex < _secondaryArguments.Count)
            {
                _secondaryArguments[secondaryIndex].Value = value;
            }

            SecondaryOperations.Add(new SetMirroredCommandLineArgsOperation(secondaryIndex, value));
        }
    }

    public int Count => _primaryArguments.Count;

    public bool IsReadOnly => false;

    public void Add(object item)
    {
        var primaryArgument = new PrimaryArgument(_nextPrimaryId++, item);
        _primaryArguments.Add(primaryArgument);
        _secondaryArguments.Add(new SecondaryArgument(item, primaryArgument.Id));
        SecondaryOperations.Add(new AddMirroredCommandLineArgsOperation(item));
    }

    public void Clear()
    {
        _primaryArguments.Clear();
        _secondaryArguments.Clear();
        SecondaryOperations.Add(new ClearMirroredCommandLineArgsOperation());
    }

    public bool Contains(object item) => _primaryArguments.Any(argument => EqualityComparer<object>.Default.Equals(argument.Value, item));

    public void CopyTo(object[] array, int arrayIndex)
    {
        foreach (var argument in _primaryArguments)
        {
            array[arrayIndex++] = argument.Value;
        }
    }

    public IEnumerator<object> GetEnumerator() => _primaryArguments.Select(static argument => argument.Value).GetEnumerator();

    public int IndexOf(object item) => _primaryArguments.FindIndex(argument => EqualityComparer<object>.Default.Equals(argument.Value, item));

    public void Insert(int index, object item)
    {
        var primaryArgument = new PrimaryArgument(_nextPrimaryId++, item);
        _primaryArguments.Insert(index, primaryArgument);

        var secondaryIndex = _secondaryArguments.FindIndex(argument =>
            argument.PrimaryId is { } primaryId &&
            _primaryArguments.FindIndex(primary => primary.Id == primaryId) > index);
        if (secondaryIndex < 0)
        {
            secondaryIndex = _secondaryArguments.Count;
        }

        _secondaryArguments.Insert(secondaryIndex, new SecondaryArgument(item, primaryArgument.Id));
        SecondaryOperations.Add(new InsertMirroredCommandLineArgsOperation(secondaryIndex, item));
    }

    public bool Remove(object item)
    {
        var index = IndexOf(item);
        if (index < 0)
        {
            return false;
        }

        _primaryArguments.RemoveAt(index);

        var secondaryIndex = _secondaryArguments.FindIndex(argument => EqualityComparer<object>.Default.Equals(argument.Value, item));
        if (secondaryIndex >= 0)
        {
            _secondaryArguments.RemoveAt(secondaryIndex);
        }

        SecondaryOperations.Add(new RemoveMirroredCommandLineArgsOperation(item));
        return true;
    }

    public void RemoveAt(int index)
    {
        var primaryId = _primaryArguments[index].Id;
        _primaryArguments.RemoveAt(index);

        var secondaryIndex = _secondaryArguments.FindIndex(argument => argument.PrimaryId == primaryId);
        if (secondaryIndex < 0)
        {
            secondaryIndex = index;
        }

        if (secondaryIndex < _secondaryArguments.Count)
        {
            _secondaryArguments.RemoveAt(secondaryIndex);
        }

        SecondaryOperations.Add(new RemoveAtMirroredCommandLineArgsOperation(secondaryIndex));
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    private sealed class PrimaryArgument(int id, object value)
    {
        public int Id { get; } = id;

        public object Value { get; set; } = value;
    }

    private sealed class SecondaryArgument(object value, int? primaryId)
    {
        public object Value { get; set; } = value;

        public int? PrimaryId { get; } = primaryId;
    }
}

internal abstract record MirroredCommandLineArgsOperation
{
    public abstract void Apply(List<object> args);
}

internal sealed record AddMirroredCommandLineArgsOperation(object Item) : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        args.Add(Item);
    }
}

internal sealed record ClearMirroredCommandLineArgsOperation : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        args.Clear();
    }
}

internal sealed record InsertMirroredCommandLineArgsOperation(int Index, object Item) : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        args.Insert(Math.Min(Index, args.Count), Item);
    }
}

internal sealed record RemoveAtMirroredCommandLineArgsOperation(int Index) : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        if (Index < args.Count)
        {
            args.RemoveAt(Index);
        }
    }
}

internal sealed record RemoveMirroredCommandLineArgsOperation(object Item) : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        args.Remove(Item);
    }
}

internal sealed record SetMirroredCommandLineArgsOperation(int Index, object Item) : MirroredCommandLineArgsOperation
{
    public override void Apply(List<object> args)
    {
        if (Index < args.Count)
        {
            args[Index] = Item;
        }
    }
}

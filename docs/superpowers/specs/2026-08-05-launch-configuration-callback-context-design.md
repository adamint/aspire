# Launch Configuration Callback Context Design

Issue: [#18956](https://github.com/microsoft/aspire/issues/18956)

Related work:

- [#18918](https://github.com/microsoft/aspire/pull/18918) made the debug-support seam public and added asynchronous launch configuration producers.
- [#18929](https://github.com/microsoft/aspire/issues/18929) tracks the separate argument-rewriting design problem.
- [#18906](https://github.com/microsoft/aspire/pull/18906) is the immediate Rust consumer.

## Problem

`WithDebugSupport` currently gives a launch configuration producer only the launch mode and, for the asynchronous overload, a cancellation token:

```csharp
Func<string, TLaunchConfiguration>
Func<string, CancellationToken, Task<TLaunchConfiguration>>
```

By the time most producers run, `ExecutableCreator.CreateObjectAsync` has already built an `IExecutionConfigurationResult` and copied its resolved arguments and environment variables into the DCP executable spec. The producer cannot access that result.

An integration that needs the resource environment must build another execution configuration. That runs `WithEnvironment` callbacks again and can produce a different result from the one Aspire actually gives the process. Rust needs the environment to resolve `CARGO_TARGET_DIR` and `CARGO_BUILD_TARGET`, so the duplicate pass can point the debugger at a binary that the real cargo invocation will not produce.

The callback signature also has no room for the other standard runtime callback values Aspire already exposes elsewhere: the resource, application execution context, logger, and cancellation token.

## Goals

- Give the producer the exact `IExecutionConfigurationResult` that Aspire used for the DCP executable.
- Use the same callback context for every custom launch configuration type, including `project`.
- Follow the standard Aspire callback shape with resource, execution context, logger, and cancellation.
- Keep `WithDebugSupport` as a synchronous builder operation while allowing asynchronous producers.
- Avoid hidden configuration evaluation in the public inspection helper.
- Preserve existing launch type selection, fallback, restart, and error behavior.

## Non-goals

- Fix the order-sensitive `argsCallback` or split process arguments from IDE arguments. That remains [#18929](https://github.com/microsoft/aspire/issues/18929).
- Change the DCP run-session protocol.
- Remove Rust's resolved cargo-argument snapshot. The current debug argument callback has already removed `cargo run ... --` from the final execution arguments before the launch producer runs.
- Remove MAUI's environment re-resolution. MAUI resolves the environment from a command-line argument callback while the execution configuration is still being gathered, before a launch producer context exists.
- Export `WithDebugSupport` or its context to polyglot AppHosts.

## Public API

Add an experimental callback context under `Aspire.Hosting.ApplicationModel`:

```csharp
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
public sealed class LaunchConfigurationCallbackContext
{
    public required string Mode { get; init; }

    public required IResource Resource { get; init; }

    public required IExecutionConfigurationResult ExecutionConfiguration { get; init; }

    public required DistributedApplicationExecutionContext ExecutionContext { get; init; }

    public ILogger Logger { get; init; } = NullLogger.Instance;

    public CancellationToken CancellationToken { get; init; }
}
```

`ExecutionConfiguration` exposes the full result rather than copying only arguments and environment variables. The result already models processed and unprocessed values, argument sensitivity, references, and additional gatherer data. Reusing it avoids a second DTO and lets future integrations consume other execution metadata without another callback signature change.

Replace the two current producer overloads with one asynchronous producer:

```csharp
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
[AspireExportIgnore(Reason = "Generic debug launch configuration support is not part of the ATS surface.")]
public static IResourceBuilder<T> WithDebugSupport<T, TLaunchConfiguration>(
    this IResourceBuilder<T> builder,
    Func<LaunchConfigurationCallbackContext, Task<TLaunchConfiguration>> launchConfigurationProducer,
    string launchConfigurationType,
    Action<CommandLineArgsCallbackContext>? argsCallback = null)
    where T : IResource;
```

There is no synchronous producer overload. A producer that does no asynchronous work returns `Task.FromResult(...)`.

The method remains named `WithDebugSupport`, not `WithDebugSupportAsync`. Calling it only registers a callback and returns an `IResourceBuilder<T>` synchronously. This matches `WithEnvironment`, `WithArgs`, `WithUrls`, and other Aspire builder APIs that accept callbacks returning `Task`.

The existing `argsCallback` remains unchanged for this issue.

## Runtime flow

`ExecutableCreator` becomes the single place where every custom launch configuration producer runs:

1. Prepare the DCP executable shape, execution type, fallback types, project arguments, and initial annotations.
2. Allocate endpoints.
3. Build the resource execution configuration once.
4. Populate the executable arguments and environment from that result.
5. Fail before the producer if `IExecutionConfigurationResult.Exception` is not `null`.
6. Create a fresh `LaunchConfigurationCallbackContext` with:
   - the selected launch mode;
   - the app model resource;
   - the same execution configuration object used for the executable spec;
   - the current application execution context;
   - the resource logger;
   - the current creation or restart cancellation token.
7. Invoke the producer and annotate the DCP executable with its returned launch configuration.

The context is created per executable creation, restart, and replica. Aspire does not cache it or the execution configuration on the resource or annotation.

### Project launch configurations

Custom `project` launch configuration producers currently run from `PrepareProjectExecutablesAsync`, before the execution configuration exists. Move those producer invocations into `CreateObjectAsync` with the other custom launch types.

Prepare-time code continues to decide whether the resource uses IDE execution and whether process fallback is available. The built-in project launch configuration used when no custom producer is active can remain prepare-time data.

This move does not remove data needed by dashboard snapshots. `ResourceSnapshotBuilder` now derives project path and launch profile directly from the app model rather than reading the launch configuration annotation.

### Restart and failure behavior

Restarts rebuild the execution configuration and create a new callback context. Existing launch configuration annotations are cleared before the new result is applied.

Configuration resolution errors continue to fail before producer invocation. A `null` task, a `null` launch configuration result, or a producer exception should produce a resource-specific diagnostic. Existing project and process-fallback behavior remains unchanged.

## Inspection helper

`DebugSupportExtensions.CreateLaunchConfigurationAsync` must not resolve configuration internally. Change it to accept an explicit callback context:

```csharp
public static Task<object> CreateLaunchConfigurationAsync(
    this IResource resource,
    LaunchConfigurationCallbackContext context);
```

The helper validates that `context.Resource` is the resource being inspected and that the supplied execution configuration succeeded. It then invokes the registered producer with that context.

This keeps the helper useful for integration tests while making evaluation explicit. A caller that wants a real execution configuration can build one with `ExecutionConfigurationBuilder`; the helper never runs resource callbacks behind the caller's back.

Only the producer's returned launch configuration is serialized to DCP. The callback context and execution configuration are not serialized automatically. Processed environment values can contain secrets, so integrations should only copy values into a launch configuration when the IDE requires them.

## Existing caller migration

Most in-tree callers only replace `mode` with `context.Mode` and wrap the result:

```csharp
builder.WithDebugSupport(
    context => Task.FromResult(
        ProjectLaunchConfigurationFactory.Create(context.Resource, context.Mode)),
    KnownLaunchConfigurationTypes.Project);
```

Go, Python, JavaScript, Azure Functions, and MAUI can keep their typed resource or metadata closures. Their only required behavior change is returning a task and reading the launch mode from the context.

Rust uses the additional runtime data:

```csharp
builder.WithDebugSupport(
    async context =>
    {
        var cargoArgs = builder.Resource.ResolvedCargoArgs
            ?? throw new InvalidOperationException(
                $"Cargo arguments for resource '{builder.Resource.Name}' have not been resolved.");
        var environment = context.ExecutionConfiguration.EnvironmentVariables
            .ToDictionary(StringComparer.Ordinal);

        var executablePath = await ResolveDebugExecutablePathAsync(
            builder.Resource,
            workingDirectory,
            context.ExecutionContext,
            environment,
            context.CancellationToken).ConfigureAwait(false);

        return new RustLaunchConfiguration
        {
            Mode = context.Mode,
            WorkingDirectory = workingDirectory,
            Cargo = new RustCargoLaunchTarget
            {
                Args = ["build", .. cargoArgs],
                ExecutablePath = executablePath
            }
        };
    },
    "rust",
    argsCallback);
```

This removes Rust's second environment-resolution pass. The cargo argument snapshot remains until #18929 changes when and how IDE-specific arguments are composed.

## Testing

Add focused coverage for:

- a non-project executable producer receiving the same `IExecutionConfigurationResult` instance used to populate the DCP executable;
- a custom project producer receiving its context after execution configuration resolution;
- environment callbacks running once per executable creation when the launch producer reads the resolved environment;
- `Resource`, `ExecutionContext`, `Logger`, and `CancellationToken` propagation;
- restart creating a fresh context and configuration instead of reusing cached data;
- the inspection helper invoking the producer with the supplied context without evaluating resource callbacks;
- the inspection helper rejecting a context for a different resource or a failed execution configuration;
- clear failures for a producer that returns a `null` task or `null` launch configuration;
- existing launch type, fallback, and argument-rewrite behavior remaining unchanged.

Update all current `WithDebugSupport` tests and integration call sites to the task-returning callback shape. The generated `api/*.cs` files are not edited manually.

## Alternatives considered

### Expose only arguments and environment variables

Rejected. It creates another projection over `IExecutionConfigurationResult` and would require more callback properties if a producer later needs references or additional gatherer data.

### Cache the last resolved configuration

Rejected. Restarts, retries, replicas, and failed resolutions make cache invalidation part of the public behavior. A stale result is worse than the current duplicate evaluation because it can silently describe a previous launch.

### Put a lazy configuration resolver on the context

Rejected. It can still execute resource callbacks twice and does not guarantee that the producer sees the same object used for the DCP executable.

### Keep separate synchronous and asynchronous producer overloads

Rejected. With a single context parameter, an async lambda can also bind to the unconstrained synchronous generic overload with `TLaunchConfiguration` inferred as `Task<T>`. The current API needs a second cancellation-token parameter and a runtime guard to avoid serializing the task itself. One task-returning producer removes that trap.

### Rename the method to `WithDebugSupportAsync`

Rejected. Registration is synchronous; only the deferred callback is asynchronous.

## Success criteria

- Launch configuration producers can consume the exact resolved execution configuration without another build pass.
- Rust no longer evaluates resource environment callbacks a second time to locate its debug executable.
- Every custom producer runs after configuration resolution through one lifecycle.
- Existing debug launch and fallback behavior remains green across hosting core and language integration tests.

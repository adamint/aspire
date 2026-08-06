# Launch Configuration Callback Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `WithDebugSupport` launch configuration producer the exact resolved execution configuration and standard runtime callback data used to create its DCP executable.

**Architecture:** Add one experimental `LaunchConfigurationCallbackContext` and one task-returning `WithDebugSupport` overload. `ExecutableCreator.CreateObjectAsync` will construct a fresh context after resolving arguments and environment variables, then invoke every active custom producer—including `project` producers—through the same path. The public inspection helper will require an explicit context so it never evaluates resource callbacks itself.

**Tech Stack:** .NET 10, C# 13, Aspire hosting application model, DCP executable model, xUnit v3 with Microsoft.Testing.Platform

---

## Scope and file structure

This plan implements the framework change and migrates every `WithDebugSupport` caller present on `microsoft/main`. The Rust integration from PR #18906 is not present on this branch, so its consumer update remains a follow-up on that PR after this framework change is available; the exact Rust migration is included at the end of this plan.

### New files

- `src/Aspire.Hosting/ApplicationModel/LaunchConfigurationCallbackContext.cs`
  - Owns the public runtime data passed to launch configuration producers.
- `tests/Aspire.Hosting.TestUtilities/Utils/LaunchConfigurationTestHelpers.cs`
  - Creates explicit callback contexts and execution results for tests without evaluating resource callbacks.

### Core files

- `src/Aspire.Hosting/ResourceBuilderExtensions.cs`
  - Replaces the two producer overloads with one context/task overload.
- `src/Aspire.Hosting/SupportsDebuggingAnnotation.cs`
  - Stores a context-based producer and annotator and supplies resource-specific producer diagnostics.
- `src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs`
  - Requires an explicit callback context for launch configuration inspection.
- `src/Aspire.Hosting/Dcp/ExecutableCreator.cs`
  - Creates the context from the authoritative execution result and moves custom `project` producer invocation to creation time.
- `src/Aspire.Hosting/ApplicationModel/ExecutableLaunchConfiguration.cs`
  - Updates XML documentation references to the final overload.

### Production callers

- `src/Aspire.Hosting/ProjectResourceBuilderExtensions.cs`
- `src/Aspire.Hosting.Azure.Functions/AzureFunctionsProjectResourceExtensions.cs`
- `src/Aspire.Hosting.Go/GoHostingExtensions.cs`
- `src/Aspire.Hosting.Python/PythonAppResourceBuilderExtensions.cs`
- `src/Aspire.Hosting.JavaScript/JavaScriptHostingExtensions.cs`
- `src/Aspire.Hosting.Maui/MauiPlatformHelper.cs`

### Tests

- `tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs`
- `tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs`
- `tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs`
- `tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs`
- `tests/Aspire.Hosting.Go.Tests/AddGoAppTests.cs`
- `tests/Aspire.Hosting.Python.Tests/AddPythonAppTests.cs`
- `tests/Aspire.Hosting.JavaScript.Tests/AddNodeAppTests.cs`
- `tests/Aspire.Hosting.JavaScript.Tests/AddBunAppTests.cs`
- `tests/Aspire.Hosting.Maui.Tests/MauiPlatformExtensionsTests.cs`

Do not edit any generated `src/*/api/*.cs` file.

### Task 1: Add the callback contract and unify the DCP lifecycle

**Consumed by:** Tasks 2, 3, 4 — production callers and tests compile against this contract, and all later behavior depends on the unified creation path

**Files:**
- Create: `src/Aspire.Hosting/ApplicationModel/LaunchConfigurationCallbackContext.cs`
- Create: `tests/Aspire.Hosting.TestUtilities/Utils/LaunchConfigurationTestHelpers.cs`
- Modify: `src/Aspire.Hosting/ResourceBuilderExtensions.cs:4750-4850`
- Modify: `src/Aspire.Hosting/SupportsDebuggingAnnotation.cs`
- Modify: `src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs:75-130`
- Modify: `src/Aspire.Hosting/Dcp/ExecutableCreator.cs:60-215, 250-345, 816-839`
- Modify: `tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs`
- Modify: `tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs:85-110`
- Modify: `tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs:445-525, 2860-2930, 3110-3235, 3980-4045, 4860-4955, 7000-7140`
- Modify: `tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs:200-247`
- Modify: `tests/Aspire.Hosting.Go.Tests/AddGoAppTests.cs:1141-1155`
- Modify: `tests/Aspire.Hosting.Python.Tests/AddPythonAppTests.cs:1622-1636`
- Modify: `tests/Aspire.Hosting.JavaScript.Tests/AddNodeAppTests.cs:629-643`
- Modify: `tests/Aspire.Hosting.JavaScript.Tests/AddBunAppTests.cs:397-411`
- Modify: `tests/Aspire.Hosting.Maui.Tests/MauiPlatformExtensionsTests.cs:882-898`

- [ ] **Step 1: Restore the worktree SDK and dependencies**

Run:

```bash
./restore.sh
```

Expected: exit code `0`; the repository-local .NET SDK is ready.

- [ ] **Step 2: Add a shared test helper for explicit callback contexts**

Create `tests/Aspire.Hosting.TestUtilities/Utils/LaunchConfigurationTestHelpers.cs`:

```csharp
// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#pragma warning disable ASPIREEXTENSION001

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Hosting.Tests.Utils;

public static class LaunchConfigurationTestHelpers
{
    public static LaunchConfigurationCallbackContext CreateCallbackContext(
        IResource resource,
        string mode = ExecutableLaunchMode.Debug,
        IExecutionConfigurationResult? executionConfiguration = null,
        DistributedApplicationExecutionContext? executionContext = null,
        ILogger? logger = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(resource);

        return new LaunchConfigurationCallbackContext
        {
            Mode = mode,
            Resource = resource,
            ExecutionConfiguration = executionConfiguration ?? CreateExecutionConfigurationResult(),
            ExecutionContext = executionContext ?? new DistributedApplicationExecutionContext(DistributedApplicationOperation.Run),
            Logger = logger ?? NullLogger.Instance,
            CancellationToken = cancellationToken
        };
    }

    public static IExecutionConfigurationResult CreateExecutionConfigurationResult(
        IEnumerable<string>? arguments = null,
        IEnumerable<KeyValuePair<string, string>>? environmentVariables = null,
        Exception? exception = null)
    {
        return new ExecutionConfigurationResult
        {
            References = [],
            ArgumentsWithUnprocessed = (arguments ?? [])
                .Select(value => ((object)value, value, false))
                .ToArray(),
            EnvironmentVariablesWithUnprocessed = (environmentVariables ?? [])
                .Select(pair => new KeyValuePair<string, (object Unprocessed, string Processed)>(
                    pair.Key,
                    (pair.Value, pair.Value)))
                .ToArray(),
            AdditionalConfigurationData = [],
            Exception = exception
        };
    }
}
```

- [ ] **Step 3: Write failing inspection-helper tests**

In `tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs`, add this private helper:

```csharp
private static Task<object> CreateLaunchConfigurationForTestAsync(
    IResource resource,
    string mode = ExecutableLaunchMode.Debug,
    CancellationToken cancellationToken = default)
{
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
        resource,
        mode,
        cancellationToken: cancellationToken);

    return resource.CreateLaunchConfigurationAsync(callbackContext);
}
```

Replace each existing call shaped as:

```csharp
resource.CreateLaunchConfigurationAsync(mode, cancellationToken)
```

with:

```csharp
CreateLaunchConfigurationForTestAsync(resource, mode, cancellationToken)
```

Use the two-argument helper call when the old call omitted its cancellation token:

```csharp
CreateLaunchConfigurationForTestAsync(resource, mode)
```

Then add these tests:

```csharp
[Fact]
public async Task CreateLaunchConfigurationUsesTheSuppliedContextWithoutEvaluatingCallbacks()
{
    using var builder = TestDistributedApplicationBuilder.Create();
    var environmentCallbackCount = 0;
    LaunchConfigurationCallbackContext? observedContext = null;

    var executable = builder.AddExecutable("app", "go", ".")
        .WithEnvironment(context =>
        {
            Interlocked.Increment(ref environmentCallbackCount);
            context.EnvironmentVariables["UNEXPECTED"] = "value";
        })
        .WithDebugSupport((LaunchConfigurationCallbackContext context) =>
        {
            observedContext = context;
            return Task.FromResult(new TestGoLaunchConfiguration
            {
                Mode = context.Mode,
                Package = context.ExecutionConfiguration.EnvironmentVariables
                    .Single(pair => pair.Key == "EXPECTED")
                    .Value
            });
        }, "go");

    var executionConfiguration = LaunchConfigurationTestHelpers.CreateExecutionConfigurationResult(
        environmentVariables: [new("EXPECTED", "./cmd/api")]);
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
        executable.Resource,
        ExecutableLaunchMode.NoDebug,
        executionConfiguration);

    var launchConfiguration = Assert.IsType<TestGoLaunchConfiguration>(
        await executable.Resource.CreateLaunchConfigurationAsync(callbackContext));

    Assert.Same(callbackContext, observedContext);
    Assert.Equal(0, environmentCallbackCount);
    Assert.Equal(ExecutableLaunchMode.NoDebug, launchConfiguration.Mode);
    Assert.Equal("./cmd/api", launchConfiguration.Package);
}

[Fact]
public async Task CreateLaunchConfigurationRejectsAContextForAnotherResource()
{
    using var builder = TestDistributedApplicationBuilder.Create();
    var executable = builder.AddExecutable("app", "go", ".")
        .WithDebugSupport(
            static context => Task.FromResult(new TestGoLaunchConfiguration { Mode = context.Mode }),
            "go");
    var other = builder.AddExecutable("other", "go", ".");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(other.Resource);

    var exception = await Assert.ThrowsAsync<ArgumentException>(
        () => executable.Resource.CreateLaunchConfigurationAsync(callbackContext));

    Assert.Equal("context", exception.ParamName);
    Assert.Contains("other", exception.Message);
    Assert.Contains("app", exception.Message);
}

[Fact]
public async Task CreateLaunchConfigurationRejectsAFailedExecutionConfiguration()
{
    using var builder = TestDistributedApplicationBuilder.Create();
    var producerCalled = false;
    var executable = builder.AddExecutable("app", "go", ".")
        .WithDebugSupport(
            context =>
            {
                producerCalled = true;
                return Task.FromResult(new TestGoLaunchConfiguration { Mode = context.Mode });
            },
            "go");
    var expectedException = new InvalidOperationException("configuration failed");
    var executionConfiguration = LaunchConfigurationTestHelpers.CreateExecutionConfigurationResult(
        exception: expectedException);
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
        executable.Resource,
        executionConfiguration: executionConfiguration);

    var exception = await Assert.ThrowsAsync<InvalidOperationException>(
        () => executable.Resource.CreateLaunchConfigurationAsync(callbackContext));

    Assert.Same(expectedException, exception);
    Assert.False(producerCalled);
}

[Fact]
public async Task CreateLaunchConfigurationThrowsWhenTheProducerReturnsANullTask()
{
    using var builder = TestDistributedApplicationBuilder.Create();
    var executable = builder.AddExecutable("app", "go", ".")
        .WithDebugSupport(
            static (LaunchConfigurationCallbackContext _) =>
                (Task<TestGoLaunchConfiguration>)null!,
            "go");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(executable.Resource);

    var exception = await Assert.ThrowsAsync<InvalidOperationException>(
        () => executable.Resource.CreateLaunchConfigurationAsync(callbackContext));

    Assert.Contains("returned a null task", exception.Message);
    Assert.Contains("app", exception.Message);
    Assert.Contains("go", exception.Message);
}

[Fact]
public async Task CreateLaunchConfigurationWrapsAProducerExceptionWithResourceContext()
{
    using var builder = TestDistributedApplicationBuilder.Create();
    var producerException = new InvalidOperationException("producer failed");
    var executable = builder.AddExecutable("app", "go", ".")
        .WithDebugSupport(
            (LaunchConfigurationCallbackContext _) =>
                Task.FromException<TestGoLaunchConfiguration>(producerException),
            "go");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(executable.Resource);

    var exception = await Assert.ThrowsAsync<InvalidOperationException>(
        () => executable.Resource.CreateLaunchConfigurationAsync(callbackContext));

    Assert.Contains("app", exception.Message);
    Assert.Contains("go", exception.Message);
    Assert.Same(producerException, exception.InnerException);
}
```

Update the existing null-result test to use the final task shape:

```csharp
var executable = builder.AddExecutable("app", "go", ".")
    .WithDebugSupport(
        static (LaunchConfigurationCallbackContext _) =>
            Task.FromResult<TestGoLaunchConfiguration>(null!),
        "go");
var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(executable.Resource);

var exception = await Assert.ThrowsAsync<InvalidOperationException>(
    () => executable.Resource.CreateLaunchConfigurationAsync(callbackContext));
```

- [ ] **Step 4: Write the failing DCP context and lifecycle tests**

Add `using System.Collections.Concurrent;` to `tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs`.

Add this non-project test next to the existing plain-executable debug tests:

```csharp
[Fact]
public async Task PlainExecutable_LaunchConfigurationProducerReceivesResolvedExecutionConfiguration()
{
    var builder = DistributedApplication.CreateBuilder();
    var environmentCallbackCount = 0;
    EnvironmentCallbackContext? environmentContext = null;
    LaunchConfigurationCallbackContext? launchContext = null;

    var resource = new TestExecutableResource("test-working-directory");
    builder.AddResource(resource)
        .WithEnvironment(context =>
        {
            Interlocked.Increment(ref environmentCallbackCount);
            environmentContext = context;
            context.EnvironmentVariables["DEBUG_VALUE"] = "resolved";
        })
        .WithDebugSupport(
            context =>
            {
                launchContext = context;
                var debugValue = context.ExecutionConfiguration.EnvironmentVariables
                    .Single(pair => pair.Key == "DEBUG_VALUE")
                    .Value;

                return Task.FromResult(new TestExecutionConfigurationLaunchConfiguration
                {
                    Mode = context.Mode,
                    DebugValue = debugValue
                });
            },
            "test");

    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DcpExecutor.DebugSessionPortVar] = "12345",
            [KnownConfigNames.DebugSessionInfo] = JsonSerializer.Serialize(new RunSessionInfo
            {
                ProtocolsSupported = ["test"],
                SupportedLaunchConfigurations = ["test"]
            }),
            [KnownConfigNames.DebugSessionRunMode] = ExecutableLaunchMode.Debug
        })
        .Build();

    var kubernetesService = new TestKubernetesService();
    using var app = builder.Build();
    var distributedAppModel = app.Services.GetRequiredService<DistributedApplicationModel>();
    var appExecutor = CreateAppExecutor(
        distributedAppModel,
        kubernetesService: kubernetesService,
        configuration: configuration);
    using var cts = new CancellationTokenSource();

    await appExecutor.RunApplicationAsync(cts.Token);

    Assert.Equal(1, environmentCallbackCount);
    Assert.NotNull(environmentContext);
    Assert.NotNull(launchContext);
    Assert.Same(resource, launchContext.Resource);
    Assert.Same(environmentContext.Resource, launchContext.Resource);
    Assert.Same(environmentContext.ExecutionContext, launchContext.ExecutionContext);
    Assert.Same(environmentContext.Logger, launchContext.Logger);
    Assert.Equal(environmentContext.CancellationToken, launchContext.CancellationToken);
    Assert.Equal(cts.Token, launchContext.CancellationToken);

    var executable = GetCreatedExecutableForResource(kubernetesService, resource.Name);
    Assert.Contains(executable.Spec.Env!, variable => variable is { Name: "DEBUG_VALUE", Value: "resolved" });
    Assert.True(executable.TryGetAnnotationAsObjectList<TestExecutionConfigurationLaunchConfiguration>(
        Executable.LaunchConfigurationsAnnotation,
        out var launchConfigurations));
    var launchConfiguration = Assert.Single(launchConfigurations);
    Assert.Equal(ExecutableLaunchMode.Debug, launchConfiguration.Mode);
    Assert.Equal("resolved", launchConfiguration.DebugValue);
}
```

Add this test launch configuration near the other private launch configuration types at the bottom of the file:

```csharp
private sealed class TestExecutionConfigurationLaunchConfiguration()
    : ExecutableLaunchConfiguration("test")
{
    [JsonPropertyName("debug_value")]
    public string DebugValue { get; set; } = string.Empty;
}
```

Add a failure-ordering test beside it:

```csharp
[Fact]
public async Task PlainExecutable_ExecutionConfigurationFailureDoesNotInvokeLaunchProducer()
{
    var builder = DistributedApplication.CreateBuilder();
    var producerCalled = false;
    var resource = new TestExecutableResource("test-working-directory");
    builder.AddResource(resource)
        .WithEnvironment(
            (EnvironmentCallbackContext _) =>
                throw new InvalidOperationException("environment failed"))
        .WithDebugSupport(
            context =>
            {
                producerCalled = true;
                return Task.FromResult(
                    new ExecutableLaunchConfiguration("test") { Mode = context.Mode });
            },
            "test");

    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DcpExecutor.DebugSessionPortVar] = "12345",
            [KnownConfigNames.DebugSessionInfo] = JsonSerializer.Serialize(new RunSessionInfo
            {
                ProtocolsSupported = ["test"],
                SupportedLaunchConfigurations = ["test"]
            })
        })
        .Build();
    var failedResources = new ConcurrentQueue<IResource>();
    var events = new DcpExecutorEvents();
    events.Subscribe<OnResourceFailedToStartContext>(context =>
    {
        failedResources.Enqueue(context.Resource);
        return Task.CompletedTask;
    });
    var kubernetesService = new TestKubernetesService();
    using var app = builder.Build();
    var distributedAppModel = app.Services.GetRequiredService<DistributedApplicationModel>();
    var appExecutor = CreateAppExecutor(
        distributedAppModel,
        kubernetesService: kubernetesService,
        configuration: configuration,
        events: events);

    await appExecutor.RunApplicationAsync();

    Assert.False(producerCalled);
    Assert.Empty(kubernetesService.CreatedResources.OfType<Executable>());
    Assert.Same(resource, Assert.Single(failedResources));
}
```

Replace `ResourceRestarted_EnvironmentCallbacksApplied` with a restart regression that also records launch callback contexts:

```csharp
[Fact]
public async Task ResourceRestarted_RebuildsExecutionConfigurationAndLaunchContext()
{
    var builder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions
    {
        AssemblyName = typeof(DistributedApplicationTests).Assembly.FullName
    });

    var callCount = 0;
    var launchContexts = new ConcurrentQueue<LaunchConfigurationCallbackContext>();
    var project = builder.AddProject<Projects.ServiceA>("ServiceA")
        .WithArgs(context => context.Args.Add("--test"))
        .WithEnvironment(context =>
        {
            var currentCall = Interlocked.Increment(ref callCount);
            context.EnvironmentVariables["CALL_COUNT"] = currentCall.ToString();
        })
        .WithDebugSupport(
            context =>
            {
                launchContexts.Enqueue(context);
                return Task.FromResult(ProjectLaunchConfigurationFactory.Create(context.Resource, context.Mode));
            },
            KnownLaunchConfigurationTypes.Project);
    var resource = project.Resource;

    var configuration = new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DcpExecutor.DebugSessionPortVar] = "12345",
            [KnownConfigNames.DebugSessionInfo] = JsonSerializer.Serialize(new RunSessionInfo
            {
                ProtocolsSupported = ["test"],
                SupportedLaunchConfigurations = [KnownLaunchConfigurationTypes.Project]
            }),
            [KnownConfigNames.DebugSessionRunMode] = ExecutableLaunchMode.Debug
        })
        .Build();
    var kubernetesService = new TestKubernetesService();
    using var app = builder.Build();
    var distributedAppModel = app.Services.GetRequiredService<DistributedApplicationModel>();
    var dcpOptions = new DcpOptions { DashboardPath = "./dashboard", ResourceNameSuffix = "suffix" };
    var events = new DcpExecutorEvents();
    var connectionStringAvailableCount = 0;
    events.Subscribe<OnConnectionStringAvailableContext>(context =>
    {
        if (ReferenceEquals(context.Resource, resource))
        {
            Interlocked.Increment(ref connectionStringAvailableCount);
        }

        return Task.CompletedTask;
    });
    var appExecutor = CreateAppExecutor(
        distributedAppModel,
        kubernetesService: kubernetesService,
        dcpOptions: dcpOptions,
        events: events,
        configuration: configuration);

    await appExecutor.RunApplicationAsync();

    var executables = GetCreatedExecutablesForResource(kubernetesService, resource.Name);
    var firstExecutable = Assert.Single(executables);
    Assert.Contains(firstExecutable.Spec.Env!, variable => variable is { Name: "CALL_COUNT", Value: "1" });
    Assert.Single(firstExecutable.Spec.Args!, argument => argument == "--no-build");
    Assert.Single(firstExecutable.Spec.Args!, argument => argument == "--test");
    Assert.True(firstExecutable.TryGetAnnotationAsObjectList<AppLaunchArgumentAnnotation>(
        CustomResource.ResourceAppArgsAnnotation,
        out var firstArgumentAnnotations));
    AssertEffectiveArgumentIndexesMatchSpecArgs(firstArgumentAnnotations, firstExecutable.Spec.Args);
    Assert.Equal(1, connectionStringAvailableCount);

    var reference = appExecutor.GetResource(firstExecutable.Metadata.Name);
    await appExecutor.StopResourceAsync(reference, CancellationToken.None);
    await appExecutor.StartResourceAsync(reference, CancellationToken.None);

    executables = GetCreatedExecutablesForResource(kubernetesService, resource.Name);
    Assert.Equal(2, executables.Count);
    var secondExecutable = executables[1];
    Assert.Contains(secondExecutable.Spec.Env!, variable => variable is { Name: "CALL_COUNT", Value: "2" });
    Assert.Single(secondExecutable.Spec.Args!, argument => argument == "--no-build");
    Assert.Single(secondExecutable.Spec.Args!, argument => argument == "--test");
    Assert.True(secondExecutable.TryGetAnnotationAsObjectList<AppLaunchArgumentAnnotation>(
        CustomResource.ResourceAppArgsAnnotation,
        out var secondArgumentAnnotations));
    AssertEffectiveArgumentIndexesMatchSpecArgs(secondArgumentAnnotations, secondExecutable.Spec.Args);
    Assert.True(secondExecutable.TryGetProjectLaunchConfiguration(out var secondLaunchConfiguration));
    Assert.NotNull(secondLaunchConfiguration);
    Assert.Equal(2, connectionStringAvailableCount);

    var contexts = launchContexts.ToArray();
    Assert.Equal(2, contexts.Length);
    Assert.NotSame(contexts[0], contexts[1]);
    Assert.NotSame(contexts[0].ExecutionConfiguration, contexts[1].ExecutionConfiguration);
    Assert.Equal(
        "1",
        contexts[0].ExecutionConfiguration.EnvironmentVariables
            .Single(pair => pair.Key == "CALL_COUNT")
            .Value);
    Assert.Equal(
        "2",
        contexts[1].ExecutionConfiguration.EnvironmentVariables
            .Single(pair => pair.Key == "CALL_COUNT")
            .Value);
}
```

Rename `ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringPrepare` to `ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate`, update its comment to say that all custom producers run from `CreateObjectAsync`, and change its callback to:

```csharp
projectBuilder.WithDebugSupport(
    async context =>
    {
        await Task.Yield();
        return new ProjectLaunchConfiguration
        {
            ProjectPath = "AsyncProducerPath",
            Mode = context.Mode,
            LaunchProfile = "async-profile"
        };
    },
    KnownLaunchConfigurationTypes.Project);
```

Update the companion comment on `PlainExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate` to reference the renamed `ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate` test and to say both producer types now share the creation path.

- [ ] **Step 5: Update direct test invocation helpers to the intended context shape**

In `tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs`, replace the direct annotator invocation with:

```csharp
var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
    executable.Resource,
    ExecutableLaunchMode.NoDebug);
await annotation.LaunchConfigurationAnnotator(exe, callbackContext);
```

Replace the Go helper in `tests/Aspire.Hosting.Go.Tests/AddGoAppTests.cs` with:

```csharp
private static async Task<GoLaunchConfiguration> InvokeLaunchConfigurationAnnotatorAsync(IResource resource)
{
    Assert.True(resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out var supportsDebugging));

    var exe = Executable.Create("test", "go");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(resource);
    await supportsDebugging.LaunchConfigurationAnnotator(exe, callbackContext);

    Assert.True(exe.TryGetAnnotationAsObjectList<GoLaunchConfiguration>(
        Executable.LaunchConfigurationsAnnotation,
        out var launchConfigs));

    return Assert.Single(launchConfigs);
}
```

Replace the Python helper in `tests/Aspire.Hosting.Python.Tests/AddPythonAppTests.cs` with:

```csharp
private static async Task<PythonLaunchConfiguration> InvokeLaunchConfigurationAnnotatorAsync(IResource resource)
{
    Assert.True(resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out var supportsDebugging));

    var exe = Executable.Create("test", "python");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(resource);
    await supportsDebugging.LaunchConfigurationAnnotator(exe, callbackContext);

    Assert.True(exe.TryGetAnnotationAsObjectList<PythonLaunchConfiguration>(
        Executable.LaunchConfigurationsAnnotation,
        out var launchConfigs));

    return Assert.Single(launchConfigs);
}
```

Replace the Node helper in `tests/Aspire.Hosting.JavaScript.Tests/AddNodeAppTests.cs` with:

```csharp
private static async Task<JavaScriptLaunchConfiguration> InvokeLaunchConfigurationAnnotatorAsync(IResource resource)
{
    Assert.True(resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out var supportsDebugging));

    var exe = Executable.Create("test", "node");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(resource);
    await supportsDebugging.LaunchConfigurationAnnotator(exe, callbackContext);

    Assert.True(exe.TryGetAnnotationAsObjectList<JavaScriptLaunchConfiguration>(
        Executable.LaunchConfigurationsAnnotation,
        out var launchConfigs));

    return Assert.Single(launchConfigs);
}
```

Replace the Bun helper in `tests/Aspire.Hosting.JavaScript.Tests/AddBunAppTests.cs` with:

```csharp
private static async Task<JavaScriptLaunchConfiguration> InvokeLaunchConfigurationAnnotatorAsync(IResource resource)
{
    Assert.True(resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out var supportsDebugging));

    var exe = Executable.Create("test", "bun");
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(resource);
    await supportsDebugging.LaunchConfigurationAnnotator(exe, callbackContext);

    Assert.True(exe.TryGetAnnotationAsObjectList<JavaScriptLaunchConfiguration>(
        Executable.LaunchConfigurationsAnnotation,
        out var launchConfigs));

    return Assert.Single(launchConfigs);
}
```

In `tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs`, use the explicit helper:

```csharp
var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
    app.Resource,
    ExecutableLaunchMode.Debug);
var launchConfig = Assert.IsType<ProjectLaunchConfiguration>(
    await app.Resource.CreateLaunchConfigurationAsync(callbackContext));
```

Apply that replacement in both project launch configuration tests.

In `tests/Aspire.Hosting.Maui.Tests/MauiPlatformExtensionsTests.cs`, replace `DeserializeLaunchConfigurationAsync` with:

```csharp
private static async Task<SerializedMauiLaunchConfiguration> DeserializeLaunchConfigurationAsync(IResource resource)
{
    var callbackContext = LaunchConfigurationTestHelpers.CreateCallbackContext(
        resource,
        ExecutableLaunchMode.Debug);
    var json = JsonSerializer.Serialize(await resource.CreateLaunchConfigurationAsync(callbackContext));
    var launchConfiguration = JsonSerializer.Deserialize<SerializedMauiLaunchConfiguration>(json);
    Assert.NotNull(launchConfiguration);

    return launchConfiguration;
}
```

- [ ] **Step 6: Run the focused tests to verify the new API is missing**

Run:

```bash
dotnet test --project tests/Aspire.Hosting.Tests/Aspire.Hosting.Tests.csproj --no-launch-profile -- --filter-class "*.DebugSupportExtensionsTests" --filter-method "*.PlainExecutable_LaunchConfigurationProducerReceivesResolvedExecutionConfiguration" --filter-method "*.PlainExecutable_ExecutionConfigurationFailureDoesNotInvokeLaunchProducer" --filter-method "*.ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate" --filter-method "*.ResourceRestarted_RebuildsExecutionConfigurationAndLaunchContext" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
```

Expected: FAIL at compile time because `LaunchConfigurationCallbackContext` does not exist and the current producer/annotator signatures do not accept it.

- [ ] **Step 7: Add the public callback context**

Create `src/Aspire.Hosting/ApplicationModel/LaunchConfigurationCallbackContext.cs`:

```csharp
// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// Provides the runtime data used to create a launch configuration for a resource.
/// </summary>
/// <remarks>
/// Aspire creates a new context for each executable creation, including restarts and replicas.
/// <see cref="ExecutionConfiguration"/> is the same resolved configuration used to populate the
/// underlying executable's arguments and environment variables.
/// </remarks>
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
public sealed class LaunchConfigurationCallbackContext
{
    /// <summary>
    /// Gets the requested launch mode, one of the values on <see cref="ExecutableLaunchMode"/>.
    /// </summary>
    public required string Mode { get; init; }

    /// <summary>
    /// Gets the resource being launched.
    /// </summary>
    public required IResource Resource { get; init; }

    /// <summary>
    /// Gets the resolved execution configuration used for the executable.
    /// </summary>
    /// <remarks>
    /// Processed environment values can contain secrets. Aspire serializes only the launch configuration
    /// returned by the producer; integrations should copy values from this result only when the IDE requires them.
    /// </remarks>
    public required IExecutionConfigurationResult ExecutionConfiguration { get; init; }

    /// <summary>
    /// Gets the execution context for the current AppHost invocation.
    /// </summary>
    public required DistributedApplicationExecutionContext ExecutionContext { get; init; }

    /// <summary>
    /// Gets the resource logger for this executable creation.
    /// </summary>
    public ILogger Logger { get; init; } = NullLogger.Instance;

    /// <summary>
    /// Gets the cancellation token for this executable creation.
    /// </summary>
    public CancellationToken CancellationToken { get; init; }
}
```

- [ ] **Step 8: Change the annotation to store context-based delegates and diagnose producer failures**

In `src/Aspire.Hosting/SupportsDebuggingAnnotation.cs`, change the constructor and internal properties to:

```csharp
private SupportsDebuggingAnnotation(
    string launchConfigurationType,
    Func<Executable, LaunchConfigurationCallbackContext, Task> launchConfigurationAnnotator,
    Func<LaunchConfigurationCallbackContext, Task<object>> launchConfigurationProducer,
    bool rewritesArgumentsForDebugging)
{
    LaunchConfigurationType = launchConfigurationType;
    LaunchConfigurationAnnotator = launchConfigurationAnnotator;
    LaunchConfigurationProducer = launchConfigurationProducer;
    RewritesArgumentsForDebugging = rewritesArgumentsForDebugging;
}

internal Func<Executable, LaunchConfigurationCallbackContext, Task> LaunchConfigurationAnnotator { get; }

internal Func<LaunchConfigurationCallbackContext, Task<object>> LaunchConfigurationProducer { get; }
```

Replace `Create<T>` with:

```csharp
internal static SupportsDebuggingAnnotation Create<T>(
    string resourceName,
    string launchConfigurationType,
    Func<LaunchConfigurationCallbackContext, Task<T>> launchConfigurationProducer,
    bool rewritesArgumentsForDebugging = false)
{
    return new SupportsDebuggingAnnotation(
        launchConfigurationType,
        async (exe, context) =>
            exe.AnnotateAsObjectList(
                Executable.LaunchConfigurationsAnnotation,
                await ProduceAsync(context).ConfigureAwait(false)),
        async context => (await ProduceAsync(context).ConfigureAwait(false))!,
        rewritesArgumentsForDebugging);

    async Task<T> ProduceAsync(LaunchConfigurationCallbackContext context)
    {
        Task<T>? producerTask;
        try
        {
            producerTask = launchConfigurationProducer(context);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !context.CancellationToken.IsCancellationRequested)
        {
            throw CreateProducerException(exception);
        }

        if (producerTask is null)
        {
            throw new InvalidOperationException(
                $"The \"{launchConfigurationType}\" launch configuration producer for resource '{resourceName}' returned a null task. " +
                "The producer must return a task that produces the complete launch configuration.");
        }

        T launchConfiguration;
        try
        {
            launchConfiguration = await producerTask.ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !context.CancellationToken.IsCancellationRequested)
        {
            throw CreateProducerException(exception);
        }

        if (launchConfiguration is null)
        {
            throw new InvalidOperationException(
                $"The \"{launchConfigurationType}\" launch configuration producer for resource '{resourceName}' returned null. " +
                "The producer owns the complete launch configuration, so it must always return one.");
        }

        return launchConfiguration;
    }

    InvalidOperationException CreateProducerException(Exception innerException)
    {
        return new InvalidOperationException(
            $"The \"{launchConfigurationType}\" launch configuration producer for resource '{resourceName}' failed.",
            innerException);
    }
}
```

- [ ] **Step 9: Add the context overload while retaining temporary migration adapters**

In `src/Aspire.Hosting/ResourceBuilderExtensions.cs`, add the final overload and move the current registration body into it:

```csharp
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
[AspireExportIgnore(Reason = "Generic debug launch configuration support is not part of the ATS surface.")]
public static IResourceBuilder<T> WithDebugSupport<T, TLaunchConfiguration>(
    this IResourceBuilder<T> builder,
    Func<LaunchConfigurationCallbackContext, Task<TLaunchConfiguration>> launchConfigurationProducer,
    string launchConfigurationType,
    Action<CommandLineArgsCallbackContext>? argsCallback = null)
    where T : IResource
{
    ArgumentNullException.ThrowIfNull(builder);
    ArgumentNullException.ThrowIfNull(launchConfigurationProducer);

    if (!builder.ApplicationBuilder.ExecutionContext.IsRunMode)
    {
        return builder;
    }

    var supportsDebuggingAnnotation = SupportsDebuggingAnnotation.Create(
        builder.Resource.Name,
        launchConfigurationType,
        launchConfigurationProducer,
        rewritesArgumentsForDebugging: argsCallback is not null && builder is IResourceBuilder<IResourceWithArgs>);

    if (argsCallback is not null && builder is IResourceBuilder<IResourceWithArgs> resourceWithArgs)
    {
        resourceWithArgs.WithArgs(context =>
        {
            if (resourceWithArgs.Resource.SupportsDebugging(builder.ApplicationBuilder.Configuration, out var activeAnnotation)
                && ReferenceEquals(activeAnnotation, supportsDebuggingAnnotation))
            {
                argsCallback(context);
            }
        });
    }

    return builder.WithAnnotation(supportsDebuggingAnnotation);
}
```

Keep the two old overloads only until Task 3, but turn them into adapters:

```csharp
return builder.WithDebugSupport(
    context => Task.FromResult(launchConfigurationProducer(context.Mode)),
    launchConfigurationType,
    argsCallback);
```

```csharp
return builder.WithDebugSupport(
    context => launchConfigurationProducer(context.Mode, context.CancellationToken),
    launchConfigurationType,
    argsCallback);
```

Retain the old sync-overload `Task`/`ValueTask` guard until Task 3 so unchanged callers keep their current diagnostic during the migration.

- [ ] **Step 10: Make inspection consume an explicit context**

Add `using System.Runtime.ExceptionServices;` to `src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs`.

Replace `CreateLaunchConfigurationAsync` with:

```csharp
/// <summary>
/// Creates the launch configuration that this resource sends to the IDE using an explicitly resolved callback context.
/// </summary>
/// <param name="resource">The resource to inspect. It must carry a <see cref="SupportsDebuggingAnnotation"/>.</param>
/// <param name="context">The callback context containing the resolved execution configuration and launch data.</param>
/// <returns>The launch configuration, typically an <see cref="ExecutableLaunchConfiguration"/>.</returns>
/// <exception cref="ArgumentException"><paramref name="context"/> belongs to a different resource.</exception>
/// <exception cref="InvalidOperationException">The resource does not declare debug launch support.</exception>
/// <remarks>
/// This method never resolves arguments or environment variables. Callers that need a real execution
/// configuration must build it explicitly with <see cref="ExecutionConfigurationBuilder"/> and place it
/// on <paramref name="context"/>.
/// </remarks>
[AspireExportIgnore(Reason = "Debug support inspection is a local .NET helper and is not part of the ATS surface.")]
public static Task<object> CreateLaunchConfigurationAsync(
    this IResource resource,
    LaunchConfigurationCallbackContext context)
{
    ArgumentNullException.ThrowIfNull(resource);
    ArgumentNullException.ThrowIfNull(context);

    if (!ReferenceEquals(resource, context.Resource))
    {
        throw new ArgumentException(
            $"The launch configuration callback context belongs to resource '{context.Resource.Name}', " +
            $"but launch configuration was requested for resource '{resource.Name}'.",
            nameof(context));
    }

    if (context.ExecutionConfiguration.Exception is { } configurationException)
    {
        ExceptionDispatchInfo.Throw(configurationException);
    }

    if (!resource.TryGetLastAnnotation<SupportsDebuggingAnnotation>(out var supportsDebuggingAnnotation))
    {
        throw new InvalidOperationException(
            $"Resource '{resource.Name}' does not declare debug launch support. " +
            $"Call {nameof(ResourceBuilderExtensions.WithDebugSupport)} on the resource first. " +
            "Note that it only adds the annotation in run mode.");
    }

    return supportsDebuggingAnnotation.LaunchConfigurationProducer(context);
}
```

- [ ] **Step 11: Invoke every custom producer from `CreateObjectAsync`**

In `PrepareProjectExecutablesAsync`, remove the custom producer call:

```csharp
if (supportsDebuggingAnnotation.LaunchConfigurationType is KnownLaunchConfigurationTypes.Project)
{
    await ApplyProjectLaunchConfigurationAsync(
        exe,
        project,
        projectMetadata,
        supportsDebuggingAnnotation,
        cancellationToken).ConfigureAwait(false);
}
```

Keep the prepare-time `CreateProjectLaunchConfiguration(...)` calls for:

- `ProjectLaunchArgsOverrideAnnotation`
- project resources without an active custom producer
- the Visual Studio fallback path where no supported custom launch type is active

Because producer invocation was the only asynchronous work in project preparation, make preparation synchronous while preserving the interface's task-returning method:

```csharp
public Task<IEnumerable<RenderedModelResource<Executable>>> PrepareObjectsAsync(
    CancellationToken cancellationToken)
{
    PrepareProjectExecutables(cancellationToken);
    PreparePlainExecutables();

    return Task.FromResult(
        _appResources.Get().OfType<RenderedModelResource<Executable>>());
}
```

Change the project-preparation method signature from:

```csharp
private async Task PrepareProjectExecutablesAsync(CancellationToken cancellationToken)
```

to:

```csharp
private void PrepareProjectExecutables(CancellationToken cancellationToken)
```

Insert this as its first statement:

```csharp
cancellationToken.ThrowIfCancellationRequested();
```

Insert the same statement as the first statement inside its `foreach (var project in modelProjectResources)` loop. The only statements removed from that loop are the active custom-producer call shown above and the `await` on the built-in fallback call, which becomes the synchronous call shown below.

Replace the debug-producer block in `CreateObjectAsync`, after the execution configuration error check, with:

```csharp
if (!er.ModelResource.HasAnnotationOfType<ForceProcessExecutionAnnotation>()
    && er.ModelResource.SupportsDebugging(_configuration, out var supportsDebuggingAnnotation))
{
    var isProjectLaunchConfiguration =
        supportsDebuggingAnnotation.LaunchConfigurationType is KnownLaunchConfigurationTypes.Project;

    if (isProjectLaunchConfiguration && !er.ModelResource.TryGetProjectMetadata(out _))
    {
        throw new FailedToApplyEnvironmentException(
            $"Resource '{er.ModelResource.Name}' declares \"project\" debug launch support (WithDebugSupport) but has no project metadata. " +
            $"The \"project\" launch configuration type is reserved for .NET project resources; use a resource that carries {nameof(IProjectMetadata)} or a different launch configuration type.");
    }

    var mode = isProjectLaunchConfiguration
        ? GetProjectLaunchConfigurationMode()
        : _configuration[KnownConfigNames.DebugSessionRunMode] ?? ExecutableLaunchMode.NoDebug;
    var callbackContext = new LaunchConfigurationCallbackContext
    {
        Mode = mode,
        Resource = er.ModelResource,
        ExecutionConfiguration = configuration,
        ExecutionContext = _executionContext,
        Logger = resourceLogger,
        CancellationToken = cancellationToken
    };

    try
    {
        // Executable objects are reused for restarts. Clear the prior launch configuration before
        // applying the freshly resolved producer result.
        exe.Annotate(Executable.LaunchConfigurationsAnnotation, string.Empty);
        await supportsDebuggingAnnotation
            .LaunchConfigurationAnnotator(exe, callbackContext)
            .ConfigureAwait(false);
    }
    catch (Exception exception) when (
        !isProjectLaunchConfiguration
        && !supportsDebuggingAnnotation.RewritesArgumentsForDebugging)
    {
        _logger.LogWarning(
            exception,
            "Failed to apply launch configuration for resource '{ResourceName}'. Falling back to process execution.",
            er.ModelResource.Name);
        exe.Spec.ExecutionType = ExecutionType.Process;
    }
}
```

Delete the stale comments that say `project` producers run during preparation. The comment above the new block should read:

```csharp
// Invoke the active launch configuration producer only after the resource execution configuration
// has been resolved. This gives every launch type, including "project", the exact arguments and
// environment used for this executable creation.
```

Replace the now-obsolete async helper with a built-in-only helper:

```csharp
private void ApplyProjectLaunchConfiguration(
    Executable exe,
    IResource project,
    IProjectMetadata projectMetadata)
{
    exe.SetProjectLaunchConfiguration(
        ProjectLaunchConfigurationFactory.Create(
            project,
            projectMetadata,
            GetProjectLaunchConfigurationMode()));
}
```

Update the Visual Studio/default fallback call in `PrepareProjectExecutablesAsync` to:

```csharp
ApplyProjectLaunchConfiguration(exe, project, projectMetadata);
```

Do not call `ApplyProjectLaunchConfiguration` for an active `SupportsDebuggingAnnotation`; its producer now owns the complete result in `CreateObjectAsync`.

Replace the remaining prepare-time producer comment with:

```csharp
// The active custom launch configuration is applied later in CreateObjectAsync, after endpoints
// and the resource execution configuration have been resolved.
```

- [ ] **Step 12: Run the focused core and direct-producer tests**

Run:

```bash
dotnet test --project tests/Aspire.Hosting.Tests/Aspire.Hosting.Tests.csproj --no-launch-profile -- --filter-class "*.DebugSupportExtensionsTests" --filter-class "*.ExecutableResourceBuilderExtensionTests" --filter-method "*.PlainExecutable_LaunchConfigurationProducerReceivesResolvedExecutionConfiguration" --filter-method "*.PlainExecutable_ExecutionConfigurationFailureDoesNotInvokeLaunchProducer" --filter-method "*.ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate" --filter-method "*.ResourceRestarted_RebuildsExecutionConfigurationAndLaunchContext" --filter-method "*.ProjectLaunchConfiguration_UsesProjectDebugSupportProducer_InDebugSession" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Dotnet.Tests/Aspire.Hosting.Dotnet.Tests.csproj --no-launch-profile -- --filter-method "*.AddDotnetProject_DebugAnnotator_ProducesProjectLaunchConfiguration" --filter-method "*.AddDotnetProject_LaunchConfiguration_ResolvesEffectiveLaunchProfile" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Go.Tests/Aspire.Hosting.Go.Tests.csproj --no-launch-profile -- --filter-method "*.WithVSCodeDebugging_PopulatesGoLaunchConfiguration" --filter-method "*.WithVSCodeDebugging_OmitsBuildFlagsWhenNoneConfigured" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Python.Tests/Aspire.Hosting.Python.Tests.csproj --no-launch-profile -- --filter-method "*.WithDebugSupport_PopulatesWorkingDirectory_ForScriptEntrypoint" --filter-method "*.WithDebugSupport_PopulatesWorkingDirectory_ForModuleEntrypoint" --filter-method "*.WithDebugSupport_PopulatesWorkingDirectory_ForExecutableEntrypoint" --filter-method "*.WithDebugSupport_PropagatesWorkingDirectoryOverride_ForExecutableEntrypoint" --filter-method "*.WithDebugSupport_PropagatesWorkingDirectoryOverride" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.JavaScript.Tests/Aspire.Hosting.JavaScript.Tests.csproj --no-launch-profile -- --filter-method "*.NodeApp_DirectFile_ProducesNodeRuntimeExecutable" --filter-method "*.ViteApp_DevServer_ProducesPackageManagerRuntimeExecutable" --filter-method "*.BunApp_DirectFile_ProducesBunRuntimeExecutable" --filter-method "*.BunApp_WithRunScriptAndPackageManager_ProducesBunRuntimeExecutable" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Maui.Tests/Aspire.Hosting.Maui.Tests.csproj --no-launch-profile -- --filter-method "*.AddMauiPlatform_EmitsMauiIdeLaunchConfiguration" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
```

Expected: all selected tests PASS.

- [ ] **Step 13: Commit the foundational runtime change**

```bash
git add \
  src/Aspire.Hosting/ApplicationModel/LaunchConfigurationCallbackContext.cs \
  src/Aspire.Hosting/ResourceBuilderExtensions.cs \
  src/Aspire.Hosting/SupportsDebuggingAnnotation.cs \
  src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs \
  src/Aspire.Hosting/Dcp/ExecutableCreator.cs \
  tests/Aspire.Hosting.TestUtilities/Utils/LaunchConfigurationTestHelpers.cs \
  tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs \
  tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs \
  tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs \
  tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs \
  tests/Aspire.Hosting.Go.Tests/AddGoAppTests.cs \
  tests/Aspire.Hosting.Python.Tests/AddPythonAppTests.cs \
  tests/Aspire.Hosting.JavaScript.Tests/AddNodeAppTests.cs \
  tests/Aspire.Hosting.JavaScript.Tests/AddBunAppTests.cs \
  tests/Aspire.Hosting.Maui.Tests/MauiPlatformExtensionsTests.cs
git commit -m "Add launch configuration callback context" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 0f29216a-bf33-40a3-9f37-3863b3d1a79e"
```

### Task 2: Migrate production launch configuration producers

**Consumed by:** Tasks 3, 4 — the legacy overloads cannot be removed until every production caller uses the new contract

**Files:**
- Modify: `src/Aspire.Hosting/ProjectResourceBuilderExtensions.cs:507-509`
- Modify: `src/Aspire.Hosting.Azure.Functions/AzureFunctionsProjectResourceExtensions.cs:188-193`
- Modify: `src/Aspire.Hosting.Go/GoHostingExtensions.cs:699-747`
- Modify: `src/Aspire.Hosting.Python/PythonAppResourceBuilderExtensions.cs:941-1015`
- Modify: `src/Aspire.Hosting.JavaScript/JavaScriptHostingExtensions.cs:2155-2295`
- Modify: `src/Aspire.Hosting.Maui/MauiPlatformHelper.cs:21-45`

- [ ] **Step 1: Migrate the built-in project producer**

In `src/Aspire.Hosting/ProjectResourceBuilderExtensions.cs`, replace the current registration with:

```csharp
builder.WithDebugSupport(
    context => Task.FromResult(
        ProjectLaunchConfigurationFactory.Create(context.Resource, context.Mode)),
    KnownLaunchConfigurationTypes.Project);
```

Using `context.Resource` here ensures the producer consumes the same resource represented by the callback context rather than relying on a captured builder.

- [ ] **Step 2: Migrate Azure Functions**

In `src/Aspire.Hosting.Azure.Functions/AzureFunctionsProjectResourceExtensions.cs`, replace the producer with:

```csharp
.WithDebugSupport(
    context => Task.FromResult(new AzureFunctionsLaunchConfiguration
    {
        ProjectPath = projectMetadata.ProjectPath,
        Mode = context.Mode
    }),
    "azure-functions");
```

- [ ] **Step 3: Migrate Go**

In `src/Aspire.Hosting.Go/GoHostingExtensions.cs`, replace the launch producer body with:

```csharp
return builder.WithDebugSupport(
    context =>
    {
        // Resolve annotations when DCP creates the launch configuration so later
        // resource mutations such as WithWorkingDirectory(...) are reflected.
        var workingDirectory = Path.GetFullPath(resource.WorkingDirectory);
        var packagePath = resource.TryGetLastAnnotation<GoPackagePathAnnotation>(out var packagePathAnnotation)
            ? packagePathAnnotation.PackagePath
            : ".";
        var buildFlags = BuildFlagsString(resource);

        return Task.FromResult(new GoLaunchConfiguration
        {
            Program = Path.GetFullPath(packagePath, workingDirectory),
            Mode = context.Mode,
            WorkingDirectory = workingDirectory,
            BuildFlags = buildFlags.Length > 0 ? buildFlags : null
        });
    },
    "go",
    static context =>
    {
        if (context.Args is not [string runCommand, ..] || runCommand != "run")
        {
            return;
        }

        context.Args.RemoveAt(0);

        while (context.Args is [string arg, ..] && IsGoRunBuildFlag(arg))
        {
            context.Args.RemoveAt(0);
        }

        if (context.Args.Count > 0)
        {
            context.Args.RemoveAt(0);
        }
    });
```

Keep the existing raw command-shape comment above the argument rewrite.

- [ ] **Step 4: Migrate Python**

In `src/Aspire.Hosting.Python/PythonAppResourceBuilderExtensions.cs`, keep the existing path/interpreter logic and change only the callback shape and return:

```csharp
builder.WithDebugSupport(
    context =>
    {
        var workingDirectory = builder.Resource.WorkingDirectory;

        string programPath;
        string module;

        if (entrypointType == EntrypointType.Script)
        {
            programPath = Path.GetFullPath(entrypoint, workingDirectory);
            module = string.Empty;
        }
        else
        {
            programPath = workingDirectory;
            module = entrypoint;
        }

        string interpreterPath;
        if (!builder.Resource.TryGetLastAnnotation<PythonEnvironmentAnnotation>(out var annotation)
            || annotation.VirtualEnvironment is null)
        {
            interpreterPath = string.Empty;
        }
        else
        {
            var venvPath = Path.IsPathRooted(annotation.VirtualEnvironment.VirtualEnvironmentPath)
                ? annotation.VirtualEnvironment.VirtualEnvironmentPath
                : Path.GetFullPath(annotation.VirtualEnvironment.VirtualEnvironmentPath, workingDirectory);

            interpreterPath = OperatingSystem.IsWindows()
                ? Path.Join(venvPath, "Scripts", "python.exe")
                : Path.Join(venvPath, "bin", "python");
        }

        return Task.FromResult(new PythonLaunchConfiguration
        {
            ProgramPath = programPath,
            Module = module,
            Mode = context.Mode,
            InterpreterPath = interpreterPath,
            WorkingDirectory = workingDirectory
        });
    },
    "python",
    static argsContext =>
    {
        // Remove entrypoint-specific arguments that VS Code will handle.
        // We need to verify the annotation to ensure we remove the correct args.
        if (!argsContext.Resource.TryGetLastAnnotation<PythonEntrypointAnnotation>(out var annotation))
        {
            return;
        }

        // For Module type: remove "-m" and module name (2 args)
        if (annotation.Type == EntrypointType.Module)
        {
            if (argsContext.Args is [string arg0, string arg1, ..]
                && arg0 == "-m"
                && arg1 == annotation.Entrypoint)
            {
                argsContext.Args.RemoveAt(0);
                argsContext.Args.RemoveAt(0);
            }
        }
        // For Script type: remove script path (1 arg)
        else if (annotation.Type == EntrypointType.Script)
        {
            if (argsContext.Args is [string arg0, ..]
                && arg0 == annotation.Entrypoint)
            {
                argsContext.Args.RemoveAt(0);
            }
        }
    });
```

- [ ] **Step 5: Migrate JavaScript and browser debugging**

For the script-path overload in `src/Aspire.Hosting.JavaScript/JavaScriptHostingExtensions.cs`, use:

```csharp
return builder.WithDebugSupport(
    context =>
    {
        var hasRunScript = resource.TryGetLastAnnotation<JavaScriptRunScriptAnnotation>(out _);
        var hasPackageManager = resource.TryGetLastAnnotation<JavaScriptPackageManagerAnnotation>(out var pmAnnotation);
        var isPackageManagerScript = hasRunScript && hasPackageManager;

        return Task.FromResult(new JavaScriptLaunchConfiguration(launchConfigType)
        {
            ScriptPath = Path.GetFullPath(scriptPath, workingDirectory),
            Mode = context.Mode,
            RuntimeExecutable = isPackageManagerScript ? pmAnnotation!.ExecutableName : launchConfigType,
            LaunchMethod = isPackageManagerScript
                ? JavaScriptLaunchConfiguration.LaunchMethodPackageManager
                : JavaScriptLaunchConfiguration.LaunchMethodDirect,
            WorkingDirectory = workingDirectory
        });
    },
    launchConfigType);
```

For the package-manager overload, use:

```csharp
return builder.WithDebugSupport(
    context =>
    {
        var packageManager = "npm";
        if (resource.TryGetLastAnnotation<JavaScriptPackageManagerAnnotation>(out var pmAnnotation))
        {
            packageManager = pmAnnotation.ExecutableName;
        }

        return Task.FromResult(new JavaScriptLaunchConfiguration("node")
        {
            ScriptPath = string.Empty,
            Mode = context.Mode,
            RuntimeExecutable = packageManager,
            LaunchMethod = JavaScriptLaunchConfiguration.LaunchMethodPackageManager,
            WorkingDirectory = workingDirectory
        });
    },
    "node");
```

For browser debugging, use:

```csharp
.WithDebugSupport(
    context =>
    {
        EndpointAnnotation? endpointAnnotation = null;
        if (parentResource.TryGetAnnotationsOfType<EndpointAnnotation>(out var endpoints))
        {
            endpointAnnotation = endpoints.FirstOrDefault(endpoint => endpoint.UriScheme == "https")
                ?? endpoints.FirstOrDefault(endpoint => endpoint.UriScheme == "http");
        }

        if (endpointAnnotation is null)
        {
            throw new InvalidOperationException(
                $"Resource '{parentResource.Name}' does not have an HTTP or HTTPS endpoint. Browser debugging requires an endpoint to navigate to.");
        }

        var endpointReference = parentResource.GetEndpoint(endpointAnnotation.Name);

        return Task.FromResult(new BrowserLaunchConfiguration
        {
            Mode = context.Mode,
            Url = endpointReference.Url,
            WebRoot = parentResource.WorkingDirectory,
            Browser = browser
        });
    },
    BrowserCapability);
```

- [ ] **Step 6: Migrate MAUI**

In `src/Aspire.Hosting.Maui/MauiPlatformHelper.cs`, replace the producer with:

```csharp
return resourceBuilder.WithDebugSupport(
    context => Task.FromResult(new MauiLaunchConfiguration
    {
        Mode = context.Mode,
        ProjectPath = projectPath,
        TargetFramework = targetFramework,
        Platform = platform,
        TargetKind = targetKind,
        Device = device,
        RuntimeIdentifier = runtimeIdentifier,
        MsBuildProperties = msBuildProperties
    }),
    MauiLaunchConfigurationType);
```

Do not change MAUI's separate environment evaluation inside its command-line argument callback; that occurs before a launch callback context exists and is explicitly outside this issue.

- [ ] **Step 7: Build every migrated production project**

Run:

```bash
dotnet build src/Aspire.Hosting/Aspire.Hosting.csproj --no-restore
dotnet build src/Aspire.Hosting.Azure.Functions/Aspire.Hosting.Azure.Functions.csproj --no-restore
dotnet build src/Aspire.Hosting.Go/Aspire.Hosting.Go.csproj --no-restore
dotnet build src/Aspire.Hosting.Python/Aspire.Hosting.Python.csproj --no-restore
dotnet build src/Aspire.Hosting.JavaScript/Aspire.Hosting.JavaScript.csproj --no-restore
dotnet build src/Aspire.Hosting.Maui/Aspire.Hosting.Maui.csproj --no-restore
```

Expected: all builds PASS with `0` warnings introduced by this change.

- [ ] **Step 8: Commit the production migrations**

```bash
git add \
  src/Aspire.Hosting/ProjectResourceBuilderExtensions.cs \
  src/Aspire.Hosting.Azure.Functions/AzureFunctionsProjectResourceExtensions.cs \
  src/Aspire.Hosting.Go/GoHostingExtensions.cs \
  src/Aspire.Hosting.Python/PythonAppResourceBuilderExtensions.cs \
  src/Aspire.Hosting.JavaScript/JavaScriptHostingExtensions.cs \
  src/Aspire.Hosting.Maui/MauiPlatformHelper.cs
git commit -m "Migrate debug launch configuration producers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 0f29216a-bf33-40a3-9f37-3863b3d1a79e"
```

### Task 3: Remove legacy overloads and migrate all tests

**Consumed by:** Task 4 — final validation assumes only the new API remains

**Files:**
- Modify: `src/Aspire.Hosting/ResourceBuilderExtensions.cs:4750-4850`
- Modify: `src/Aspire.Hosting/SupportsDebuggingAnnotation.cs:10-25`
- Modify: `src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs:75-125`
- Modify: `src/Aspire.Hosting/ApplicationModel/ExecutableLaunchConfiguration.cs:45-105`
- Modify: `tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs`
- Modify: `tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs`
- Modify: `tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs`
- Modify: `tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs:308-360`

- [ ] **Step 1: Delete both legacy producer overloads**

Delete these signatures and their implementations from `ResourceBuilderExtensions.cs`:

```csharp
Func<string, TLaunchConfiguration>
```

```csharp
Func<string, CancellationToken, Task<TLaunchConfiguration>>
```

This also deletes the `Task`/`ValueTask` runtime guard; overload resolution can no longer infer `TLaunchConfiguration` as a task because there is only one task-returning producer shape.

Keep the method named `WithDebugSupport`. Do not add `WithDebugSupportAsync`: registration returns the builder synchronously, and only the deferred producer is asynchronous.

Keep one final overload with this XML documentation:

```csharp
/// <summary>
/// Adds support for debugging the resource in an IDE or extension host.
/// </summary>
/// <typeparam name="T">The resource type.</typeparam>
/// <typeparam name="TLaunchConfiguration">The launch configuration type produced for the resource, typically derived from <see cref="ExecutableLaunchConfiguration"/>.</typeparam>
/// <param name="builder">The resource builder.</param>
/// <param name="launchConfigurationProducer">
/// A callback that receives the resolved execution configuration and runtime launch context, and asynchronously
/// produces the complete launch configuration handed to the IDE.
/// </param>
/// <param name="launchConfigurationType">The type tag of the launch configuration sent to the IDE.</param>
/// <param name="argsCallback">Optional callback to add or modify command-line arguments while this debug support annotation is active.</param>
/// <returns>The <see cref="IResourceBuilder{T}"/>.</returns>
/// <remarks>
/// Registering debug support is synchronous; Aspire invokes <paramref name="launchConfigurationProducer"/>
/// later for each executable creation, restart, or replica. A producer that completes synchronously should
/// return its result with <see cref="Task.FromResult{TResult}(TResult)"/>.
/// </remarks>
[Experimental("ASPIREEXTENSION001", UrlFormat = "https://aka.ms/aspire/diagnostics/{0}")]
[AspireExportIgnore(Reason = "Generic debug launch configuration support is not part of the ATS surface.")]
public static IResourceBuilder<T> WithDebugSupport<T, TLaunchConfiguration>(
    this IResourceBuilder<T> builder,
    Func<LaunchConfigurationCallbackContext, Task<TLaunchConfiguration>> launchConfigurationProducer,
    string launchConfigurationType,
    Action<CommandLineArgsCallbackContext>? argsCallback = null)
    where T : IResource
```

- [ ] **Step 2: Update all API documentation references**

In `SupportsDebuggingAnnotation.cs`, replace the old overload references with:

```csharp
/// Added by <see cref="ResourceBuilderExtensions.WithDebugSupport{T, TLaunchConfiguration}(IResourceBuilder{T}, Func{LaunchConfigurationCallbackContext, Task{TLaunchConfiguration}}, string, Action{CommandLineArgsCallbackContext})"/>.
```

In `DebugSupportExtensions.cs`, describe the explicit context helper and reference the same final overload. Remove all wording about "its asynchronous overload."

In `ExecutableLaunchConfiguration.cs`, replace both old `WithDebugSupport` cref values with:

```csharp
<see cref="ResourceBuilderExtensions.WithDebugSupport{T, TLaunchConfiguration}(IResourceBuilder{T}, Func{LaunchConfigurationCallbackContext, Task{TLaunchConfiguration}}, string, Action{CommandLineArgsCallbackContext})"/>
```

Update the `Mode` remarks to say that the requested mode is available through `LaunchConfigurationCallbackContext.Mode`.

- [ ] **Step 3: Migrate every core test producer**

Apply these exact callback transformations in:

- `tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs`
- `tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs`
- `tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs`
- `tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs`

Mode-dependent synchronous producer:

```csharp
// Before
mode => new ExecutableLaunchConfiguration("test") { Mode = mode }

// After
context => Task.FromResult(
    new ExecutableLaunchConfiguration("test") { Mode = context.Mode })
```

Producer that ignores the context:

```csharp
// Before
_ => new ExecutableLaunchConfiguration("test")

// After
static _ => Task.FromResult(new ExecutableLaunchConfiguration("test"))
```

Genuinely asynchronous producer:

```csharp
// Before
async (mode, cancellationToken) =>
{
    await Task.Yield();
    return new ExecutableLaunchConfiguration("test") { Mode = mode };
}

// After
async context =>
{
    await Task.Yield();
    return new ExecutableLaunchConfiguration("test") { Mode = context.Mode };
}
```

Where an existing producer reads its `cancellationToken` parameter, replace that read with `context.CancellationToken`; do not add a new cancellation check to producers that did not previously perform one.

Custom project producer:

```csharp
context => Task.FromResult(new ProjectLaunchConfiguration
{
    Mode = context.Mode,
    ProjectPath = "ProducerSuppliedPath",
    DisableLaunchProfile = true
})
```

Argument-rewriting registrations retain the existing `argsCallback` unchanged:

```csharp
.WithDebugSupport(
    context => Task.FromResult(
        new ExecutableLaunchConfiguration("custom") { Mode = context.Mode }),
    "custom",
    context => context.Args.Add("rewritten-arg"))
```

Update the two method-group callbacks in `DcpExecutorTests.cs` to:

```csharp
static Task<ProjectLaunchConfiguration> CreateProjectLaunchConfiguration(
    LaunchConfigurationCallbackContext context)
{
    throw new InvalidOperationException("Project launch configuration failed.");
}
```

```csharp
static Task<ExecutableLaunchConfiguration> ThrowingLaunchConfiguration(
    LaunchConfigurationCallbackContext context)
{
    throw new InvalidOperationException("Launch configuration failed.");
}
```

Delete these obsolete tests from `ExecutableResourceBuilderExtensionTests.cs`:

- `WithDebugSupportAsynchronousProducerProducesTheSameAnnotationAsTheSynchronousOne`
- `WithDebugSupportRejectsATaskReturningSynchronousProducer`
- `WithDebugSupportRejectsAValueTaskReturningSynchronousProducer`

The replacement coverage is:

- `CreateLaunchConfigurationUsesTheSuppliedContextWithoutEvaluatingCallbacks`
- `ProjectExecutable_AsyncLaunchConfigurationProducer_IsAwaitedDuringCreate`
- the null-task and null-result diagnostics

- [ ] **Step 4: Update failure assertions for the resource-specific wrapper**

Where DCP tests currently assert only the raw producer text, keep that assertion against the logged exception chain and also assert the resource-specific outer diagnostic:

```csharp
Assert.Contains(
    logLines,
    line => line.Content.Contains(
        "The \"project\" launch configuration producer for resource 'TestDotnetProject' failed.",
        StringComparison.Ordinal));
Assert.Contains(
    logLines,
    line => line.Content.Contains(
        "Project launch configuration failed.",
        StringComparison.Ordinal));
```

For non-project fallback tests, continue asserting that:

- non-rewriting producers fall back to `ExecutionType.Process`;
- argument-rewriting producers fail rather than offering an invalid process fallback;
- project producers fail without a process fallback.

- [ ] **Step 5: Audit that no legacy producer shape remains**

Run:

```bash
rg -n -U '\.WithDebugSupport\(\s*(?:async\s*)?\([^)]*,[^)]*\)\s*=>' src tests --glob '*.cs'
rg -n -U '\.WithDebugSupport\(\s*[A-Za-z_][A-Za-z0-9_]*\s*=>\s*new ' src tests --glob '*.cs'
rg -n 'Func<string, TLaunchConfiguration>|Func<string, CancellationToken, Task<TLaunchConfiguration>>' src/Aspire.Hosting --glob '*.cs' --glob '!api/*.cs'
```

Expected: no matches. Matches in generated `src/*/api/*.cs` files are ignored and must not be edited.

- [ ] **Step 6: Run the core regression tests**

Run:

```bash
dotnet test --project tests/Aspire.Hosting.Tests/Aspire.Hosting.Tests.csproj --no-launch-profile -- --filter-class "*.DebugSupportExtensionsTests" --filter-class "*.ExecutableResourceBuilderExtensionTests" --filter-method "*.PlainExecutable_*Debug*" --filter-method "*.PlainExecutable_ExecutionConfigurationFailureDoesNotInvokeLaunchProducer" --filter-method "*.ProjectExecutable_*LaunchConfiguration*" --filter-method "*.ProjectLaunchConfiguration_*" --filter-method "*.DotnetProjectExecutable_*" --filter-method "*.ResourceRestarted_RebuildsExecutionConfigurationAndLaunchContext" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Dotnet.Tests/Aspire.Hosting.Dotnet.Tests.csproj --no-launch-profile -- --filter-method "*.AddDotnetProject_*Debug*" --filter-method "*.AddDotnetProject_LaunchConfiguration_ResolvesEffectiveLaunchProfile" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the final API shape and test migration**

```bash
git add \
  src/Aspire.Hosting/ResourceBuilderExtensions.cs \
  src/Aspire.Hosting/SupportsDebuggingAnnotation.cs \
  src/Aspire.Hosting/ApplicationModel/DebugSupportExtensions.cs \
  src/Aspire.Hosting/ApplicationModel/ExecutableLaunchConfiguration.cs \
  tests/Aspire.Hosting.Tests/DebugSupportExtensionsTests.cs \
  tests/Aspire.Hosting.Tests/ExecutableResourceBuilderExtensionTests.cs \
  tests/Aspire.Hosting.Tests/Dcp/DcpExecutorTests.cs \
  tests/Aspire.Hosting.Dotnet.Tests/DotnetProjectResourceTests.cs
git commit -m "Finalize debug callback context API" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 0f29216a-bf33-40a3-9f37-3863b3d1a79e"
```

### Task 4: Validate the complete change

**Consumed by:** nothing

**Files:**
- Verify only; no source files should change

- [ ] **Step 1: Build the repository without native AOT**

Run:

```bash
./build.sh --build /p:SkipNativeBuild=true
```

Expected: build PASS with no new warnings.

- [ ] **Step 2: Run the affected test projects**

Run:

```bash
dotnet test --project tests/Aspire.Hosting.Tests/Aspire.Hosting.Tests.csproj --no-launch-profile -- --filter-class "*.DebugSupportExtensionsTests" --filter-class "*.ExecutableResourceBuilderExtensionTests" --filter-method "*.PlainExecutable_*Debug*" --filter-method "*.PlainExecutable_ExecutionConfigurationFailureDoesNotInvokeLaunchProducer" --filter-method "*.ProjectExecutable_*LaunchConfiguration*" --filter-method "*.ProjectLaunchConfiguration_*" --filter-method "*.DotnetProjectExecutable_*" --filter-method "*.ResourceRestarted_RebuildsExecutionConfigurationAndLaunchContext" --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Dotnet.Tests/Aspire.Hosting.Dotnet.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Azure.Tests/Aspire.Hosting.Azure.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Go.Tests/Aspire.Hosting.Go.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Python.Tests/Aspire.Hosting.Python.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.JavaScript.Tests/Aspire.Hosting.JavaScript.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
dotnet test --project tests/Aspire.Hosting.Maui.Tests/Aspire.Hosting.Maui.Tests.csproj --no-launch-profile -- --filter-not-trait "quarantined=true" --filter-not-trait "outerloop=true"
```

Expected: all projects PASS.

- [ ] **Step 3: Verify the diff and generated API boundary**

Run:

```bash
git diff --check
git diff --name-only HEAD~3..HEAD -- 'src/*/api/*.cs'
rg -n -U '\.WithDebugSupport\(\s*(?:async\s*)?\([^)]*,[^)]*\)\s*=>' src tests --glob '*.cs'
rg -n 'Func<string, TLaunchConfiguration>|Func<string, CancellationToken, Task<TLaunchConfiguration>>' src/Aspire.Hosting --glob '*.cs' --glob '!api/*.cs'
git status --short
```

Expected:

- `git diff --check` prints nothing.
- No generated API file is listed.
- Both legacy-shape searches print nothing.
- `git status --short` is clean.

## Rust PR #18906 follow-up

After this framework change is available on the Rust PR branch, replace its launch producer with:

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

Delete Rust's second environment `ExecutionConfigurationBuilder` pass. Keep `ResolvedCargoArgs` until issue #18929 changes how process and IDE arguments are composed.

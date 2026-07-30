# Rust app hosting integration

Use this integration to model, configure, and orchestrate Rust applications in an Aspire solution.

## Getting started

### Prerequisites

The **Rust toolchain** (`cargo`) must be available on the PATH of the machine running the AppHost.
Install it with [rustup](https://www.rust-lang.org/tools/install).

For VS Code debugging, install the platform's native debugger extension:
[C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) on Windows, or
[CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) on Linux and macOS.

### Add the integration

From your AppHost directory, add the `Aspire.Hosting.Rust` integration with the Aspire CLI:

```bash
aspire add Aspire.Hosting.Rust
```

## Usage example

In the AppHost, add a Rust application resource:

**C#**

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddRustApp("api", "../rust-api")
    .WithHttpEndpoint(env: "PORT")
    .WithExternalHttpEndpoints()
    .WithOtlpExporter();

builder.Build().Run();
```

**TypeScript**

```typescript
import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const api = await builder.addRustApp("api", "../rust-api")
    .withHttpEndpoint({ env: "PORT" })
    .withExternalHttpEndpoints()
    .withOtlpExporter();

await builder.build().run();
```

`appDirectory` is the directory containing `Cargo.toml`. Arguments for your program are passed with
`.WithArgs(...)`; arguments for cargo itself are passed with `.WithCargoArgs(...)`.

Read the listening port from the environment variable named by `WithHttpEndpoint(env: ...)` rather
than hard-coding one, so Aspire can assign a free port and wire up service discovery.

### Cargo options

```csharp
builder.AddRustApp("api", "../rust-api")
    .WithCargoReleaseBuild()
    .WithCargoFeatures("grpc-tonic", "tls-ring")
    .WithCargoArgs("--no-default-features", "--locked");
```

| Method | Effect |
| --- | --- |
| `WithCargoArgs(params string[] args)` | Appends raw arguments to the cargo command line |
| `WithCargoArgs(Action<RustCargoArgsCallbackContext> callback)` | Computes cargo arguments when the resource starts. An async `Func<RustCargoArgsCallbackContext, Task>` overload is also available |
| `WithCargoReleaseBuild()` | Adds `--release` |
| `WithCargoFeatures(params string[] features)` | Adds `--features` with the supplied features |

These options apply to local execution and debugging alike.

Cargo's target selection flags need no dedicated API — pass them like any other cargo argument. A
crate with several `[[bin]]` targets is selected the same way `cargo run` requires:

```csharp
builder.AddRustApp("api", "../rust-api")
    .WithCargoArgs("--bin", "worker");
```

### Debugging

Debugging is enabled automatically by `AddRustApp` — use the normal Aspire "Start Debugging" flow in
VS Code. Library-only crates produce no executable and cannot be debugged.

Debugging builds the crate with the same cargo arguments used to run it, so any `--bin`/`--example`
selection carries over. One case differs from `cargo run`: `cargo build` ignores the `default-run`
manifest key, so a crate that relies on `default-run` alone builds every binary and debugging cannot
tell which to launch. Pass `--bin` explicitly through `WithCargoArgs` in that case.

## Additional documentation

- https://aspire.dev/integrations/gallery/
- https://aspire.dev/integrations/frameworks/rust/rust-host/
- [Aspire documentation](https://aspire.dev/)
- [The Cargo Book](https://doc.rust-lang.org/cargo/)

## Feedback & contributing

https://github.com/microsoft/aspire

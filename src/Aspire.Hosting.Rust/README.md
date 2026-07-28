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

Read the listening port from the environment variable named by `WithHttpEndpoint(env: ...)` and bind
to all interfaces (`0.0.0.0`). A `127.0.0.1` listener works while Aspire runs the app as a host
process, but is unreachable once the app is published into a container.

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
| `WithCargoBinTarget(string binName)` | Adds `--bin <name>`, selecting one binary from a crate that declares several |

These options apply to local execution, debugging, and publishing alike.

### Running under bacon

`AddBaconApp` runs a crate under [bacon](https://dystroy.org/bacon/), which rebuilds and reruns it as
source files change. It requires `bacon` on the PATH:

```csharp
builder.AddBaconApp("api", "../rust-api");
```

### Publishing

A Rust app publishes to a container. If `appDirectory` contains a `Dockerfile` it is used as-is;
otherwise one is generated for you.

The `beta` and `nightly` toolchain channels have no official Docker image, so pin images explicitly
when your crate requires them:

```csharp
#pragma warning disable ASPIREDOCKERFILEBUILDER001

builder.AddRustApp("api", "../rust-api")
    .WithDockerfileBaseImage(
        buildImage: "rustlang/rust:nightly-bookworm",
        runtimeImage: "debian:bookworm-slim");
```

`WithDockerfileBaseImage` is experimental, so its `ASPIREDOCKERFILEBUILDER001` diagnostic must be
suppressed. When you supply a non-Alpine runtime image, that image is responsible for providing CA
certificates and any non-root user you want the app to run as.

Crates that declare more than one `[[bin]]` target must select one with `WithCargoBinTarget`.

### Debugging

Debugging is enabled automatically by `AddRustApp` — use the normal Aspire "Start Debugging" flow in
VS Code. Library-only crates produce no executable and cannot be debugged. If a crate defines several
binaries, select the one to debug with `WithCargoBinTarget`.

## Additional documentation

- https://aspire.dev/integrations/gallery/
- https://aspire.dev/integrations/frameworks/rust/rust-host/
- [Aspire documentation](https://aspire.dev/)
- [The Cargo Book](https://doc.rust-lang.org/cargo/)
- [bacon](https://dystroy.org/bacon/)

## Feedback & contributing

https://github.com/microsoft/aspire

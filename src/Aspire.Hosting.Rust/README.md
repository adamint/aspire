# Rust hosting integration

Use this integration to model, configure, and orchestrate a Rust application resource in an Aspire
solution.

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

Then, in the AppHost, add a Rust application resource and reference it from another resource with
either C# or TypeScript:

**C#**

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddRustApp("api", "../rust-api")
    .WithHttpEndpoint(env: "PORT")
    .WithExternalHttpEndpoints();

var web = builder.AddProject<Projects.Web>("web")
                 .WithReference(api);

builder.Build().Run();
```

**TypeScript**

```typescript
import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const api = await builder.addRustApp("api", "../rust-api")
    .withHttpEndpoint({ env: "PORT" })
    .withExternalHttpEndpoints();

const web = await builder.addNodeApp("web", "../web", "server.js")
    .withReference(api);

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
    .WithCargoLocked()
    .WithCargoFeatures("grpc-tonic", "tls-ring")
    .WithCargoArgs("--no-default-features");
```

| Method | Effect |
| --- | --- |
| `WithCargoArgs(params string[] args)` | Appends raw arguments to the cargo command line |
| `WithCargoArgs(Action<RustCargoArgsCallbackContext> callback)` | Computes cargo arguments when the resource starts. An async `Func<RustCargoArgsCallbackContext, Task>` overload is also available |
| `WithCargoReleaseBuild(bool releaseBuild = true)` | Adds `--release`. Publishing adds it by default, so pass `false` to publish an unoptimized image |
| `WithCargoLocked(bool locked = true)` | Adds `--locked`, which fails rather than updating `Cargo.lock`. Publishing adds it by default whenever the crate has a lock file, so pass `false` to opt out |
| `WithCargoFeatures(params string[] features)` | Adds `--features` with the supplied features |
| `WithCargoBinTarget(string binName)` | Adds `--bin` to select one of several `[[bin]]` targets |
| `WithCargoExample(string exampleName)` | Adds `--example` to run an example instead of a binary |
| `WithCargoPackage(string packageName)` | Adds `--package` to select a workspace member |
| `WithCargoTarget(string target)` | Adds `--target` to cross-compile for a specific triple |
| `WithCargoManifestPath(string manifestPath)` | Adds `--manifest-path`. Only needed when the manifest is not the one cargo finds from the app directory. Must be inside the app directory so publishing can copy it into the image |
| `WithCargoProfile(string profileName)` | Adds `--profile`. Takes precedence over `WithCargoReleaseBuild()`, which cargo rejects alongside `--profile` |

These options apply to local execution, debugging, and publishing alike, except that publishing turns
on `--release` and (when a `Cargo.lock` exists) `--locked` unless the resource said otherwise: a
published image should be optimized and should build the dependency versions that were committed,
while local runs keep cargo's own defaults so they stay fast and behave like running `cargo run` from
the terminal. Target selection in particular must go through the dedicated methods rather than
`WithCargoArgs`, because debugging and publishing use them to work out which file cargo produces:

```csharp
builder.AddRustApp("api", "../rust-api")
    .WithCargoBinTarget("worker");
```

### Debugging

Debugging is enabled automatically by `AddRustApp` — use the normal Aspire "Start Debugging" flow in
VS Code. Library-only crates produce no executable and cannot be debugged.

Debugging builds the crate with the same cargo arguments used to run it, so any `--bin`/`--example`
selection carries over. The AppHost works out the executable cargo will produce — from the same
`cargo metadata` query publishing uses — and hands the path to the debugger, so the debugged process
and the published container run the same binary. That resolution honours the `default-run` manifest
key, which `cargo build` itself ignores.

### Publishing

`aspire publish` and `aspire deploy` build the app into a container. An app that runs should publish
with no extra configuration: if the app directory contains a `Dockerfile` it is used as-is, otherwise
one is generated that compiles the crate inside the container — nothing is built on your machine —
and copies the binary into a small runtime image. The container runs as a non-root `app` user with uid
and gid `999`, so anything it writes to a mounted volume is owned by `999`.

The only thing publishing may need help with is which binary to ship, when the crate itself is
ambiguous: a package with several `[[bin]]` targets needs `WithCargoBinTarget`, and a workspace with
several default members that each produce a binary needs `WithCargoPackage`. `default-run` is honoured,
so publish otherwise produces the same binary `cargo run` does. Only the `WithCargo*` options feed that
choice — a target selected with a raw `WithCargoArgs` string changes what cargo builds without moving
the file publish copies.

#### Base images

| Stage | Default |
| --- | --- |
| Build | `rust:<version>-alpine`, where `<version>` comes from `rust-toolchain.toml`/`rust-toolchain`, the crate's `rust-version`, or `1.89` when the crate pins nothing |
| Runtime | `alpine:3.22` |

Both defaults are musl-based, so the binary and the runtime image share a libc by construction.
Nothing is installed into either image, so each provides exactly what it ships: a crate needing a CA
bundle, a zoneinfo database, or a C toolchain to build should name an image carrying it.

Overriding a stage makes matching the pair yours to get right — a glibc (`-gnu`) build image needs a
glibc runtime image, and a musl one needs musl:

```csharp
builder.AddRustApp("api", "../rust-api")
    .WithDockerfileBaseImage(buildImage: "rust:1.89-bookworm", runtimeImage: "debian:bookworm-slim");
```

The same applies to a triple passed to `WithCargoTarget`, which must match the runtime image's libc,
and needs a build image carrying a cross-linker when it targets another architecture.

## Additional documentation

- https://aspire.dev/integrations/gallery/
- https://aspire.dev/integrations/frameworks/rust/rust-host/
- [Aspire documentation](https://aspire.dev/)
- [The Cargo Book](https://doc.rust-lang.org/cargo/)

## Feedback & contributing

https://github.com/microsoft/aspire

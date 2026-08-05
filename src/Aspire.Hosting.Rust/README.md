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

`aspire publish` and `aspire deploy` build the app into a container. If the app directory already
contains a `Dockerfile`, that file is used as-is. Otherwise a multi-stage Dockerfile is generated
(`--locked` appears only when the crate has a `Cargo.lock`):

```dockerfile
FROM rust:1.89-alpine AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --locked --release --target-dir /build/target

FROM alpine:3.22
RUN apk --no-cache add ca-certificates tzdata
RUN (addgroup -g 999 -S app || groupadd --system --gid 999 app) && \
    (adduser -u 999 -S -G app app || useradd --system --uid 999 --gid 999 --no-create-home app)
WORKDIR /app
COPY --from=build /build/target/release/my-service /app/my-service
USER app
ENTRYPOINT ["/app/my-service"]
```

The crate is **only ever compiled inside the container**. The AppHost does not run `cargo build`
during publish; it runs `cargo metadata`, a manifest query that neither compiles nor downloads
dependencies, purely to learn the name of the binary cargo will produce.

Publishing assumes the app already runs, so it does not re-validate anything cargo would itself have
rejected at `cargo run` time. It only reports the cases where run mode works but the produced file
name is still unknowable: a package with several `[[bin]]` targets that no option selects (call
`WithCargoBinTarget`), or a workspace with several default members that each produce a binary (call
`WithCargoPackage`). A workspace that pairs one app crate with library crates resolves on its own.
`default-run` is honoured, so publish produces the same binary `cargo run` does. The same reasoning
applies to debugging, which shares this resolution.

Only the `WithCargo*` options feed that resolution. Values passed through `WithCargoArgs` are
forwarded to cargo verbatim and are not parsed, so a target selection made with a raw `--bin`,
`--example`, `--package`, `--target`, `--release` or `--profile` changes what cargo builds without
moving the file publish copies or the debugger launches. Use the dedicated method for those.

The container build pins `--target-dir`, so a `build.target-dir` in the crate's `.cargo/config.toml`
moves the local build output without moving what the image copies.

#### Base images

| Stage | Default |
| --- | --- |
| Build | `rust:<version>-alpine`, where `<version>` comes from `rust-toolchain.toml`/`rust-toolchain`, or `rust:1.89-alpine` when the crate pins nothing |
| Runtime | `alpine:3.22` |

When the crate pins no toolchain but declares a `rust-version` newer than `1.89`, that version is
used instead: cargo refuses to build with an older toolchain than the declared minimum.

Both defaults are musl-based, so the binary and the runtime image share a libc by construction and
there is no glibc-version skew between the two stages.

The build stage installs no extra packages, so it provides exactly what the official image ships. The
Alpine images have carried `gcc` for years but only gained `musl-dev` in Rust 1.92.0, so a crate with
native dependencies (or a build script) that pins an older toolchain has to supply a build image that
provides them through `WithDockerfileBaseImage`, or take over the build with its own `Dockerfile`.

rustup channel names are not container image tags, so they are mapped: `stable` becomes `rust:alpine`
(the unversioned tag that tracks current stable, since there is no `rust:stable-alpine`), and
`nightly`/`nightly-<date>` become `rustlang/rust:nightly-alpine`/`rustlang/rust:nightly-<date>-alpine`.
`beta` publishes no image, so it fails with a message pointing at `WithDockerfileBaseImage`.

Override either stage to move to glibc:

```csharp
builder.AddRustApp("api", "../rust-api")
    .WithDockerfileBaseImage(buildImage: "rust:1.89-bookworm", runtimeImage: "debian:bookworm-slim");
```

`ca-certificates` and `tzdata` are installed into the default runtime image only, because that is the
one whose contents are known: `alpine:3.22` ships neither, and a service that cannot verify a TLS
certificate is of little use. A runtime image passed to `WithDockerfileBaseImage` is used exactly as
given, so it has to provide those itself — `debian:bookworm-slim`, for one, carries no CA bundle. The
non-root `app` user is created in either case, trying the BusyBox commands and falling back to
shadow-utils, with uid and gid pinned to `999` so a mounted volume sees the same owner on any distro.

`WithCargoTarget(...)` adds `rustup target add <triple>` to the build stage and follows cargo's
`target/<triple>/<profile>/` layout. Pairing the triple with base images that can build and run the
result is yours to get right — a glibc (`-gnu`) triple needs glibc base images, and a triple for
another architecture needs a cross-linker in the build image, since `rustup target add` installs only
the target's standard library. `WithDockerfileBaseImage` supplies both.

## Additional documentation

- https://aspire.dev/integrations/gallery/
- https://aspire.dev/integrations/frameworks/rust/rust-host/
- [Aspire documentation](https://aspire.dev/)
- [The Cargo Book](https://doc.rust-lang.org/cargo/)

## Feedback & contributing

https://github.com/microsoft/aspire

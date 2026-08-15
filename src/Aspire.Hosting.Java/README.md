# Java hosting integration

Use this integration to model, configure, and orchestrate a Java application resource in an Aspire solution.

## Getting started

### Prerequisites

A **JDK** must be available on the PATH of the machine running the AppHost. Aspire does not install one.

Applications are normally launched through the **Maven or Gradle wrapper** (`mvnw`/`gradlew`) checked into
the project, which needs nothing else installed. When a project ships no wrapper, `mvn` or `gradle` has to
be on the PATH instead, or a wrapper elsewhere has to be selected with `WithWrapperPath(...)`.

For VS Code debugging, install
[Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) and
[Debugger for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-debug).

### Add the integration

From your AppHost directory, add the `Aspire.Hosting.Java` integration with the Aspire CLI:

```bash
aspire add Aspire.Hosting.Java
```

## Usage example

Then, in the AppHost, add a Java application resource and reference it from another resource with either C# or TypeScript:

**C#**

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var catalog = builder.AddJavaApp("catalog", "../catalog")
    .WithMavenGoal("spring-boot:run")
    // Spring Boot reads SERVER_PORT, so the port Aspire assigns reaches the app with no code change.
    .WithHttpEndpoint(env: "SERVER_PORT")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.Frontend>("frontend")
    .WithReference(catalog)
    .WaitFor(catalog);

builder.Build().Run();
```

**TypeScript**

```typescript
import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const catalog = await builder.addJavaApp("catalog", "../catalog");
await catalog.withMavenGoal("spring-boot:run", []);
await catalog.withHttpEndpoint({ env: "SERVER_PORT" });
await catalog.withExternalHttpEndpoints();

const orders = await builder.addJavaApp("orders", "../orders");
await orders.withGradleTask("bootRun", []);
await orders.withHttpEndpoint({ env: "SERVER_PORT" });
await orders.withReference(catalog);
await orders.waitFor(catalog);

await builder.build().run();
```

`appDirectory` is the process working directory and the publish build context, so everything the build
needs must live inside it.

### Launch modes

A resource runs in exactly one of three ways, and configuring a second one throws:

| Mode | How to select it | What runs |
| --- | --- | --- |
| Prebuilt JAR | `AddJavaApp(name, appDirectory, jarPath)` | `java -jar <jarPath>` |
| Maven goal | `WithMavenGoal("spring-boot:run")` | `mvnw spring-boot:run` |
| Gradle task | `WithGradleTask("bootRun")` | `gradlew bootRun` |

Arguments passed to `AddJavaApp` or `WithArgs(...)` belong to the application. Arguments for the build
tool are passed to `WithMavenGoal`/`WithGradleTask`, which keeps the two sets separable — the IDE needs
to drop the wrapper's arguments when it launches the JVM directly to debug it.

### Building before running

```csharp
builder.AddJavaApp("worker", "../worker", "target/worker.jar")
    .WithMavenBuild("-B", "-ntp", "-DskipTests", "package");
```

`WithMavenBuild`/`WithGradleBuild` add a child resource that runs before the application starts, and the
application waits for it to succeed. The same arguments also drive the container build during
`aspire publish`, so they should produce the deployable artifact — `build -x test` rather than `classes`
for Gradle, for example.

### Options

| Method | Effect |
| --- | --- |
| `WithMavenGoal(string goal, params string[] args)` | Launches through `mvnw` with the given goal |
| `WithGradleTask(string task, params string[] args)` | Launches through `gradlew` with the given task |
| `WithMavenBuild(params string[] args)` | Builds with Maven before the app runs, and in the published container |
| `WithGradleBuild(params string[] args)` | Builds with Gradle before the app runs, and in the published container |
| `WithWrapperPath(string wrapperScript)` | Selects a wrapper outside the app directory. May be called before or after the build tool is configured |
| `WithMainClass(string mainClass)` | The fully qualified class the IDE launches when debugging |
| `WithJarArtifact(string jarPath)` | Names the JAR the container build should deploy, when the build produces more than one |
| `WithJvmArgs(params string[] args)` | Appends JVM arguments through `JAVA_TOOL_OPTIONS` |
| `WithOtelAgent(string agentPath)` | Runs the app under the OpenTelemetry Java agent |

### Telemetry

`AddJavaApp` configures the OTLP exporter environment on its own, which is all a manually instrumented
application needs. `WithOtelAgent(...)` additionally runs the
[OpenTelemetry Java agent](https://github.com/open-telemetry/opentelemetry-java-instrumentation), which
instruments common frameworks with no code change:

```csharp
builder.AddJavaApp("catalog", "../catalog")
    .WithMavenBuild("-B", "-ntp", "-DskipTests", "package")
    .WithMavenGoal("spring-boot:run")
    .WithOtelAgent("target/agent/opentelemetry-javaagent.jar");
```

The agent is not downloaded for you. Fetch it as a build dependency so it exists before the application
starts — a relative path is resolved against the app directory when running locally, and the published
container copies the build's agent into the image. Because the agent is applied through
`JAVA_TOOL_OPTIONS`, which every JVM beneath the resource inherits, the build tool's own JVM is
instrumented as well.

### Debugging

Debugging is enabled automatically by `AddJavaApp` — use the normal Aspire "Start Debugging" flow in
VS Code. The IDE launches the JVM directly rather than through the wrapper, because `spring-boot:run`
and `bootRun` fork a second JVM that a debugger attached to the wrapper would never see. Set
`WithMainClass(...)` to say which class to launch; for a prebuilt JAR the JAR itself is used and the
debugger reads `Main-Class` from its manifest.

### Publishing

`aspire publish` and `aspire deploy` build the app into a container. An app that runs should publish with
no extra configuration: if the app directory contains a `Dockerfile` it is used as-is, otherwise one is
generated that builds the project inside the container. The container runs as a non-root `app` user, and
the JVM is PID 1 so it receives `SIGTERM` directly and shutdown hooks run.

The generated build stage reuses the wrapper and the arguments from `WithMavenBuild`/`WithGradleBuild`,
falling back to `package` or `build` when neither is configured. Dependency caches are kept in a BuildKit
cache mount rather than baked into a layer.

The deployed JAR is whichever one the build produces, ignoring `-plain`, `-sources`, and `-javadoc`
artifacts. When that is still ambiguous the build fails and names the candidates; select one with
`WithJarArtifact(...)`.

#### Base images

The Java release is read from `pom.xml` or the Gradle build file, and defaults to 21.

| Stage | Default |
| --- | --- |
| Build (wrapper present) | `docker.io/library/eclipse-temurin:{version}-jdk` |
| Build (Maven, no wrapper) | `docker.io/library/maven:3-eclipse-temurin-{version}` |
| Build (Gradle, no wrapper) | `docker.io/library/gradle:8-jdk{version}` |
| Runtime | `docker.io/library/eclipse-temurin:{version}-jre` |

Override both stages in a single call:

```csharp
builder.AddJavaApp("catalog", "../catalog")
    .WithDockerfileBaseImage(
        buildImage: "example/java-build:latest",
        runtimeImage: "example/java-runtime:latest");
```

## Additional documentation

- https://aspire.dev/integrations/gallery/
- https://aspire.dev/integrations/frameworks/java/
- [Aspire documentation](https://aspire.dev/)
- [Maven Wrapper](https://maven.apache.org/wrapper/)
- [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html)

## Feedback & contributing

https://github.com/microsoft/aspire

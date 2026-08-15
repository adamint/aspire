// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

var builder = DistributedApplication.CreateBuilder(args);

// Gives `aspire publish` somewhere to publish to. Each Java resource turns into a container image built
// from a Dockerfile that Aspire generates from the resource's build tool and target Java release.
builder.AddDockerComposeEnvironment("compose");

// Maven, launched through the Spring Boot plugin.
//
// The build step is not optional here. The OpenTelemetry agent is downloaded by the POM into
// target/agent rather than committed to the repository, and JAVA_TOOL_OPTIONS applies to the wrapper
// process itself — so without a build that has already run, the very first JVM would try to load an
// agent JAR that does not exist yet and die during VM initialization. The build step runs as a separate
// resource that does not inherit JAVA_TOOL_OPTIONS, and the application waits for it to complete.
var catalog = builder.AddJavaApp("catalog", "../catalog")
    .WithMavenBuild("-B", "-ntp", "-DskipTests", "package")
    .WithMavenGoal("spring-boot:run")
    .WithOtelAgent("target/agent/opentelemetry-javaagent.jar")
    // Spring Boot reads SERVER_PORT, so the port Aspire assigns reaches the application without any
    // code in the application itself. No targetPort is pinned: these are host processes rather than
    // containers, so a fixed target port is a real port on the machine and two services asking for
    // 8080 would collide.
    .WithHttpEndpoint(env: "SERVER_PORT")
    .WithHttpHealthCheck("/actuator/health")
    .WithExternalHttpEndpoints();

// Gradle, launched through bootRun. Same shape as the Maven service, which is the point: the two build
// tools are interchangeable from the AppHost's perspective.
var orders = builder.AddJavaApp("orders", "../orders")
    // "build -x test" rather than "classes": the same arguments drive the pre-launch build here and the
    // container build during `aspire publish`, and publishing needs an actual JAR in build/libs.
    .WithGradleBuild("build", "-x", "test")
    .WithGradleTask("bootRun")
    .WithOtelAgent("build/agent/opentelemetry-javaagent.jar")
    .WithHttpEndpoint(env: "SERVER_PORT")
    .WithHttpHealthCheck("/actuator/health")
    .WithExternalHttpEndpoints()
    // Projects the catalog endpoint as services__catalog__http__0 and holds orders back until catalog
    // reports healthy, so its first request cannot race the other service's startup.
    .WithReference(catalog)
    .WaitFor(catalog);

// A plain JAR with no framework, built by Maven before it runs. The module ships no wrapper of its own,
// so it borrows the catalog service's.
builder.AddJavaApp("worker", "../worker", "target/worker-0.0.1-SNAPSHOT.jar", ["--interval-seconds", "10"])
    .WithWrapperPath("../catalog/mvnw")
    .WithMavenBuild("-B", "-ntp", "-DskipTests", "package")
    // Publishing has to know which JAR is the application. Without this the container build would find
    // both worker-0.0.1-SNAPSHOT.jar and any classifier artifacts and refuse to guess.
    .WithJarArtifact("target/worker-0.0.1-SNAPSHOT.jar")
    .WithJvmArgs("-Xmx128m");

#if !SKIP_DASHBOARD_REFERENCE
builder.AddProject<Projects.Aspire_Dashboard>(KnownResourceNames.AspireDashboard);
#endif

builder.Build().Run();

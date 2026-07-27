// To run this app in this repo use the following command line to ensure latest changes are always picked up:
// $ dotnet apphost.cs --no-cache

// These directives are not required in regular apps, only here in the aspire repo itself
/*
#:sdk Aspire.AppHost.Sdk
*/
#:property IsAspireHost=true
#:property PublishAot=false
#:property UserSecretsId=02bbcc01-7921-4f54-9a52-7a711f3fe1f4

#:property TreatProjectReferencesAsResources=false
#:project ../../src/Aspire.Hosting.Rust/Aspire.Hosting.Rust.csproj
#:project ../../src/Aspire.Hosting.Redis/Aspire.Hosting.Redis.csproj

var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddRustApp("app", "./app")
    .WithHttpEndpoint(env: "PORT")
    .WithHttpHealthCheck("/health")
    .WithReference(cache)
    .WaitFor(cache);

builder.Build().Run();

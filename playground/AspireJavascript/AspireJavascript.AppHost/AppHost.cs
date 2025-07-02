var builder = DistributedApplication.CreateBuilder(args);

// .NET MinimalAPI
var weatherApi = builder.AddProject<Projects.AspireJavaScript_MinimalApi>("weatherapi")
    .WithExternalHttpEndpoints();

// Node.js Express API (equivalent to the MinimalAPI)
var nodeWeatherApi = builder.AddNpmApp("node-weather-api", "../AspireJavaScript.NodeApi")
    .WithHttpEndpoint(port: 5085, env: "PORT")
    .WithExternalHttpEndpoints();

// React frontend that can use either API
builder.AddNpmApp("react", "../AspireJavaScript.React")
    .WithReference(weatherApi)
    .WithReference(nodeWeatherApi)
    .WaitFor(weatherApi)
    .WaitFor(nodeWeatherApi)
    .WithEnvironment("BROWSER", "none") // Disable opening browser on npm start
    .WithHttpEndpoint(env: "PORT")
    .WithExternalHttpEndpoints();
    
builder.Build().Run();

// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Aspire.Hosting.Tests;

public class ServerReadyActionSerializationTests
{
    [Fact]
    public void ServerReadyAction_Serializes_ExpectedJsonShape()
    {
        // This test guards the public JSON contract we emit for VS Code, including:
        // - stable property names (action/pattern/uriFormat/webRoot/name/config/killOnServerStop)
        // - action being serialized as the correct string literal, not as an enum name or numeric value.
        var config = new System.Text.Json.Nodes.JsonObject
        {
            ["type"] = "pwa-chrome",
            ["request"] = "launch",
            ["port"] = 1234,
            ["nested"] = new System.Text.Json.Nodes.JsonObject
            {
                ["enabled"] = true
            }
        };

        var props = new TestDebuggerProperties
        {
            Type = "coreclr",
            Name = "My Debug Config",
            WorkingDirectory = "/work",
            ServerReadyAction = new ServerReadyAction
            {
                Action = ServerReadyActionAction.StartDebugging,
                Pattern = "\\bNow listening on: (https?://\\S+)",
                UriFormat = "%s",
                WebRoot = "/client",
                Name = "FollowUp",
                Config = config,
                KillOnServerStop = true,
            }
        };

        var json = System.Text.Json.JsonSerializer.Serialize(props);

        using var doc = System.Text.Json.JsonDocument.Parse(json);

        // Ensure we serialize the base debugger properties using the VS Code schema.
        Assert.Equal("coreclr", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("My Debug Config", doc.RootElement.GetProperty("name").GetString());
        Assert.Equal("/work", doc.RootElement.GetProperty("cwd").GetString());

        var serverReadyAction = doc.RootElement.GetProperty("serverReadyAction");

        Assert.Equal("startDebugging", serverReadyAction.GetProperty("action").GetString());
        Assert.Equal("\\bNow listening on: (https?://\\S+)", serverReadyAction.GetProperty("pattern").GetString());
        Assert.Equal("%s", serverReadyAction.GetProperty("uriFormat").GetString());
        Assert.Equal("/client", serverReadyAction.GetProperty("webRoot").GetString());
        Assert.Equal("FollowUp", serverReadyAction.GetProperty("name").GetString());
        Assert.True(serverReadyAction.GetProperty("killOnServerStop").GetBoolean());

        var configElement = serverReadyAction.GetProperty("config");
        Assert.Equal("pwa-chrome", configElement.GetProperty("type").GetString());
        Assert.Equal("launch", configElement.GetProperty("request").GetString());
        Assert.Equal(1234, configElement.GetProperty("port").GetInt32());
        Assert.True(configElement.GetProperty("nested").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public void ServerReadyAction_RoundTrips_KnownActionAndConfig()
    {
        // This test ensures we can deserialize the JSON we emit back into the model.
        // It specifically covers the new ServerReadyActionAction wrapper and JsonObject config payload.
        var json = """
        {
            "type": "coreclr",
            "request": "launch",
            "name": "My Debug Config",
            "cwd": "/work",
            "serverReadyAction": {
                "action": "startDebugging",
                "pattern": "listening on port ([0-9]+)",
                "name": "FollowUp",
                "config": { "foo": "bar" },
                "killOnServerStop": true
            }
        }
        """;

        var roundtripped = System.Text.Json.JsonSerializer.Deserialize<TestDebuggerProperties>(json);

        Assert.NotNull(roundtripped);
        Assert.NotNull(roundtripped.ServerReadyAction);

        Assert.Equal(ServerReadyActionAction.StartDebugging, roundtripped.ServerReadyAction.Action);
        Assert.Equal("listening on port ([0-9]+)", roundtripped.ServerReadyAction.Pattern);
        Assert.Equal("FollowUp", roundtripped.ServerReadyAction.Name);
        Assert.True(roundtripped.ServerReadyAction.KillOnServerStop);

        Assert.NotNull(roundtripped.ServerReadyAction.Config);
        Assert.Equal("bar", roundtripped.ServerReadyAction.Config["foo"]!.GetValue<string>());
    }

    [Fact]
    public void ServerReadyAction_Allows_UnknownActionStrings()
    {
        // VS Code and debug adapters may introduce new action strings over time.
        // This test ensures we don't fail deserialization when encountering an unrecognized value.
        var json = """
        {
            "type": "coreclr",
            "request": "launch",
            "name": "My Debug Config",
            "cwd": "/work",
            "serverReadyAction": {
                "action": "someFutureAction",
                "pattern": "listening on port ([0-9]+)",
                "killOnServerStop": false
            }
        }
        """;

        var roundtripped = System.Text.Json.JsonSerializer.Deserialize<TestDebuggerProperties>(json);

        Assert.NotNull(roundtripped);
        Assert.NotNull(roundtripped.ServerReadyAction);
        Assert.NotNull(roundtripped.ServerReadyAction.Action);
        Assert.Equal("someFutureAction", roundtripped.ServerReadyAction.Action.Value.Value);

        Assert.False(roundtripped.ServerReadyAction.Action.Value.TryGetKind(out _));
    }

    private sealed class TestDebuggerProperties : VSCodeDebuggerProperties
    {
        [System.Text.Json.Serialization.JsonPropertyName("type")]
        public override required string Type { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public override required string Name { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("cwd")]
        public override required string WorkingDirectory { get; init; }
    }
}

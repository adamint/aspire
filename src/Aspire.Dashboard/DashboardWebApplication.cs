// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Net;
using Aspire.Dashboard.Components;
using Aspire.Dashboard.Model;
using Aspire.Dashboard.Otlp.Grpc;
using Aspire.Dashboard.Otlp.Security;
using Aspire.Dashboard.Otlp.Storage;
using Microsoft.AspNetCore.HttpsPolicy;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.FluentUI.AspNetCore.Components;

namespace Aspire.Dashboard;

public class DashboardWebApplication
{
    private const string DashboardOtlpUrlVariableName = "DOTNET_DASHBOARD_OTLP_ENDPOINT_URL";
    private const string DashboardOtlpUrlDefaultValue = "http://localhost:18889";
    private const string DashboardUrlVariableName = "ASPNETCORE_URLS";
    private const string DashboardUrlDefaultValue = "http://localhost:18888";

    private readonly WebApplication _app;

    public DashboardWebApplication()
    {
        var builder = WebApplication.CreateBuilder();

        builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.None);
        builder.Logging.AddFilter("Microsoft.AspNetCore.Server.Kestrel", LogLevel.Error);

        var dashboardUris = builder.Configuration.GetUris(DashboardUrlVariableName, new(DashboardUrlDefaultValue));

        var otlpUris = builder.Configuration.GetUris(DashboardOtlpUrlVariableName, new(DashboardOtlpUrlDefaultValue));

        if (otlpUris.Length > 1)
        {
            throw new InvalidOperationException("Only one URL for Aspire dashboard OTLP endpoint is supported.");
        }

        var dashboardHttpsPort = dashboardUris.FirstOrDefault(IsHttps)?.Port;
        var isAllHttps = dashboardHttpsPort is not null && IsHttps(otlpUris[0]);

        builder.WebHost.ConfigureKestrel(kestrelOptions =>
        {
            ConfigureListenAddresses(kestrelOptions, dashboardUris);
            ConfigureListenAddresses(kestrelOptions, otlpUris, options =>
            {
                options.Protocols = HttpProtocols.Http2;
                options.UseOtlpConnection();
            });
        });

        if (isAllHttps)
        {
            // Explicitly configure the HTTPS redirect port as we're possibly listening on multiple HTTPS addresses
            // if the dashboard OTLP URL is configured to use HTTPS too
            builder.Services.Configure<HttpsRedirectionOptions>(options => options.HttpsPort = dashboardHttpsPort);
        }

        // Add services to the container.
        builder.Services.AddRazorComponents().AddInteractiveServerComponents();

        // Data from the server.
        builder.Services.AddScoped<IDashboardClient, DashboardClient>();

        // OTLP services.
        builder.Services.AddGrpc(options => options.Interceptors.Add<OtlpInterceptor>());
        builder.Services.AddSingleton<TelemetryRepository>();
        builder.Services.AddTransient<StructuredLogsViewModel>();
        builder.Services.AddTransient<TracesViewModel>();
        builder.Services.TryAddEnumerable(ServiceDescriptor.Scoped<IOutgoingPeerResolver, ResourceOutgoingPeerResolver>());
        builder.Services.TryAddEnumerable(ServiceDescriptor.Scoped<IOutgoingPeerResolver, BrowserLinkOutgoingPeerResolver>());

        builder.Services.AddFluentUIComponents();

        builder.Services.AddSingleton<ThemeManager>();

        builder.Services.AddLocalization();

        _app = builder.Build();

        // this needs to be explicitly enumerated for each supported language
        // our language list comes from https://github.com/dotnet/arcade/blob/89008f339a79931cc49c739e9dbc1a27c608b379/src/Microsoft.DotNet.XliffTasks/build/Microsoft.DotNet.XliffTasks.props#L22
        var supportedLanguages = new[]
        {
            "en", "cs", "de", "es", "fr", "it", "ja", "ko", "pl", "pt-BR", "ru", "tr", "zh-Hans", "zh-Hant"
        };

        _app.UseRequestLocalization(new RequestLocalizationOptions()
            .AddSupportedCultures(supportedLanguages)
            .AddSupportedUICultures(supportedLanguages));

        var logger = _app.Logger;

        if (dashboardUris.FirstOrDefault() is { } reportedDashboardUri)
        {
            // dotnet watch needs the trailing slash removed. See https://github.com/dotnet/sdk/issues/36709
            logger.LogInformation("Now listening on: {DashboardUri}", reportedDashboardUri.AbsoluteUri.TrimEnd('/'));
        }

        if (otlpUris.FirstOrDefault() is { } reportedOtlpUri)
        {
            // This isn't used by dotnet watch but still useful to have for debugging
            logger.LogInformation("OTLP server running at: {OtlpEndpointUri}", reportedOtlpUri.AbsoluteUri.TrimEnd('/'));
        }

        // Redirect browser directly to /StructuredLogs address if the dashboard is running without a resource service.
        // This is done to avoid immediately navigating in the Blazor app.
        _app.Use(async (context, next) =>
        {
            if (context.Request.Path.Equals(TargetLocationInterceptor.ResourcesPath, StringComparisons.UrlPath))
            {
                var client = context.RequestServices.GetRequiredService<IDashboardClient>();
                if (!client.IsEnabled)
                {
                    context.Response.Redirect(TargetLocationInterceptor.StructuredLogsPath);
                    return;
                }
            }

            await next(context).ConfigureAwait(false);
        });

        // Configure the HTTP request pipeline.
        if (_app.Environment.IsDevelopment())
        {
            _app.UseDeveloperExceptionPage();
            //_app.UseBrowserLink();
        }
        else
        {
            _app.UseExceptionHandler("/Error");
            //_app.UseHsts();
        }

        if (isAllHttps)
        {
            _app.UseHttpsRedirection();
        }

        _app.UseStaticFiles(new StaticFileOptions()
        {
            OnPrepareResponse = context =>
            {
                // If Cache-Control isn't already set to something, set it to 'no-cache' so that the
                // ETag and Last-Modified headers will be respected by the browser.
                // This may be able to be removed if https://github.com/dotnet/aspnetcore/issues/44153
                // is fixed to make this the default
                if (context.Context.Response.Headers.CacheControl.Count == 0)
                {
                    context.Context.Response.Headers.CacheControl = "no-cache";
                }
            }
        });

        _app.UseAuthorization();

        _app.UseAntiforgery();

        _app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

        // OTLP gRPC services.
        _app.MapGrpcService<OtlpMetricsService>();
        _app.MapGrpcService<OtlpTraceService>();
        _app.MapGrpcService<OtlpLogsService>();
    }

    public void Run() => _app.Run();

    private static void ConfigureListenAddresses(KestrelServerOptions kestrelOptions, Uri[] uris, Action<ListenOptions>? configureListenOptions = null)
    {
        foreach (var uri in uris)
        {
            if (uri.IsLoopback)
            {
                kestrelOptions.ListenLocalhost(uri.Port, ConfigureListenOptions);
            }
            else
            {
                kestrelOptions.Listen(IPAddress.Parse(uri.Host), uri.Port, ConfigureListenOptions);
            }

            void ConfigureListenOptions(ListenOptions options)
            {
                if (IsHttps(uri))
                {
                    options.UseHttps();
                }
                configureListenOptions?.Invoke(options);
            }
        }
    }

    private static bool IsHttps(Uri uri) => string.Equals(uri.Scheme, "https", StringComparison.Ordinal);
}

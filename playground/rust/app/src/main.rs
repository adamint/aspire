use axum::{routing::get, Router};
use opentelemetry::global::{self, BoxedTracer};
use opentelemetry::trace::{Span, SpanKind, Status, Tracer};
use opentelemetry::KeyValue;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::WithTonicConfig;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use std::net::SocketAddr;
use std::sync::OnceLock;
use tonic::transport::{Certificate, ClientTlsConfig};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static REQUEST_COUNTER: OnceLock<opentelemetry::metrics::Counter<u64>> = OnceLock::new();

fn get_request_counter() -> &'static opentelemetry::metrics::Counter<u64> {
    REQUEST_COUNTER.get_or_init(|| {
        global::meter("rust-apphost-playground")
            .u64_counter("http.server.request.count")
            .with_description("Total number of HTTP requests.")
            .build()
    })
}

fn get_tracer() -> &'static BoxedTracer {
    static TRACER: OnceLock<BoxedTracer> = OnceLock::new();
    TRACER.get_or_init(|| global::tracer("rust-apphost-playground"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let telemetry = init_telemetry()?;
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);

    let address = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(%address, "starting rust sample");

    let app = Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/ping", get(health));

    let listener = tokio::net::TcpListener::bind(address).await?;
    let server_result = axum::serve(listener, app).await;
    telemetry.shutdown();
    server_result?;
    Ok(())
}

async fn index() -> &'static str {
    let tracer = get_tracer();
    let mut span = tracer
        .span_builder("GET /")
        .with_kind(SpanKind::Server)
        .start(tracer);

    get_request_counter().add(1, &[KeyValue::new("http.route", "/")]);
    tracing::info!(
        name: "http.request",
        route = "/",
        message = "Serving Hello World page"
    );
    span.set_status(Status::Ok);

    "Hello World from Rust"
}

async fn health() -> &'static str {
    let tracer = get_tracer();
    let mut span = tracer
        .span_builder("GET /health")
        .with_kind(SpanKind::Server)
        .start(tracer);

    get_request_counter().add(1, &[KeyValue::new("http.route", "/health")]);
    tracing::info!(name: "http.request", route = "/health", message = "Health check");
    span.set_status(Status::Ok);

    "healthy"
}

fn init_telemetry() -> Result<OtelTelemetry, Box<dyn std::error::Error + Send + Sync>> {
    let tls = create_tls_config()?;

    let trace_exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_tls_config(tls.clone())
        .build()?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(trace_exporter)
        .build();
    global::set_tracer_provider(tracer_provider.clone());

    let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
        .with_tonic()
        .with_tls_config(tls.clone())
        .build()?;
    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(metric_exporter)
        .build();
    global::set_meter_provider(meter_provider.clone());

    let log_exporter = opentelemetry_otlp::LogExporter::builder()
        .with_tonic()
        .with_tls_config(tls)
        .build()?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_batch_exporter(log_exporter)
        .build();

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(OpenTelemetryTracingBridge::new(&logger_provider))
        .try_init()?;

    Ok(OtelTelemetry {
        tracer_provider,
        meter_provider,
        logger_provider,
    })
}

fn create_tls_config() -> Result<ClientTlsConfig, Box<dyn std::error::Error + Send + Sync>> {
    let mut tls = ClientTlsConfig::new();

    if let Ok(cert_file) = std::env::var("SSL_CERT_FILE") {
        let pem = std::fs::read(cert_file)?;
        tls = tls.ca_certificate(Certificate::from_pem(pem));
    }

    Ok(tls)
}

struct OtelTelemetry {
    tracer_provider: SdkTracerProvider,
    meter_provider: SdkMeterProvider,
    logger_provider: SdkLoggerProvider,
}

impl OtelTelemetry {
    fn shutdown(self) {
        if let Err(error) = self.tracer_provider.shutdown() {
            eprintln!("failed to shut down tracer provider: {error}");
        }
        if let Err(error) = self.meter_provider.shutdown() {
            eprintln!("failed to shut down meter provider: {error}");
        }
        if let Err(error) = self.logger_provider.shutdown() {
            eprintln!("failed to shut down logger provider: {error}");
        }
    }
}

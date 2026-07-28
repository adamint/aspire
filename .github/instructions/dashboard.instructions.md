---
applyTo: "src/Aspire.Dashboard/**/*.{cs,razor,js}"
---

# Dashboard Review Patterns

- Dashboard subscription/watch callbacks can run concurrently; protect shared mutable state with locking or concurrent collections.
- Prefer FluentUI for standard interactive controls. Raw HTML is fine when semantics, performance, or UX require it; if working around a FluentUI limitation, cite the FluentUI issue.
- Use `ViewportInformation.IsDesktop` / `IsUltraLowHeight` cascading parameter for responsive layout; throttle (not debounce) resize events to avoid excessive re-renders of the entire component tree.
- Use `@onclick:stopPropagation="true"` on interactive elements inside `FluentDataGrid` rows that have row-click handlers to prevent unintended navigation.
- Prefer JS interop for browser-only, latency-sensitive interactions (clipboard, global DOM listeners). If you register a persistent JS listener, keep a handle and unregister in `DisposeAsync`.
- For high-throughput log/trace/metric streams with a fixed cap, use `CircularBuffer<T>` instead of repeatedly removing the first item from a `List<T>`.
- For bounded channels feeding one consumer, prefer `BoundedChannelFullMode.DropOldest` and set `SingleReader = true`.
- Use `FormatHelpers` for culture-aware date/time/number display. Reserve invariant formatting for intentionally fixed diagnostic formats.
- Localize user-visible dashboard text with resource-backed localizers. Prefer typed localizers and `nameof` keys when practical, but existing model/helpers also generate localized UI text.
- Never let a server-side request target a URL derived from untrusted input, and never send a dashboard credential to a host that isn't pinned. Telemetry is untrusted: OTLP payloads and the resource model (span attributes, log bodies, `WithUrls` values) come from monitored apps, which can be arbitrary third-party containers. So a favicon fetch, health probe, or assistant/MCP tool that dereferences a URL out of telemetry is SSRF. Follow `DebugSessionHelpers.CreateHttpClient`: pin the host (`localhost`) and the server certificate *first*, then attach the token. The resource service in `DashboardClient` is the one deliberate exception — its address is startup-only operator config and must be arbitrary.

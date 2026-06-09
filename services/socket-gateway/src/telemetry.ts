/**
 * OpenTelemetry bootstrap (side-effect module).
 *
 * IMPORTANT: this file must be the FIRST import in the service entrypoint so the
 * SDK starts before `node:http`, `ioredis`, `pg`, etc. are loaded and can be
 * auto-instrumented.
 *
 * Entirely no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — dev, test and
 * local runs never need a collector. Configuration is the standard OTel env set:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://otel-collector:4318
 *   - OTEL_EXPORTER_OTLP_HEADERS    e.g. authorization=Bearer xxx
 *   - OTEL_SERVICE_NAME             defaults to the per-service name below
 *
 * Under ESM, full auto-instrumentation also needs the loader hook — run the
 * service with NODE_OPTIONS="--import @opentelemetry/instrumentation/hook.mjs"
 * (see docs/PRODUCTION.md). The SDK still starts cleanly without it.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const DEFAULT_SERVICE_NAME = 'socket-gateway';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = DEFAULT_SERVICE_NAME;

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are extremely noisy and low value for these services.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[otel] tracing enabled for ${process.env.OTEL_SERVICE_NAME}`);

  const shutdown = (): void => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

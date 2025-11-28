// Import with `const Sentry = require("@sentry/nestjs");` if you are using CJS
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  // Parse traces sample rate from env or use defaults
  const tracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE
    ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : process.env.NODE_ENV === 'production'
      ? 0.1 // 10% in production
      : 1.0; // 100% in development

  Sentry.init({
    dsn,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    // Environment tag for filtering in Sentry dashboard
    environment: process.env.NODE_ENV || 'development',
    // Release tracking (optional, can be set via env)
    release: process.env.SENTRY_RELEASE,
    // Performance Monitoring - traces sample rate
    // Controls the percentage of transactions that are sent to Sentry
    // 1.0 = 100% of transactions, 0.1 = 10% of transactions
    // Tracing is automatically enabled when tracesSampleRate is set
    // The SentryModule.forRoot() in app.module.ts enables NestJS-specific tracing
    tracesSampleRate,
  });

  console.log(
    `[Sentry] Error tracking and tracing initialized (sample rate: ${tracesSampleRate * 100}%)`,
  );
} else {
  console.log('[Sentry] DSN not configured, skipping initialization');
}

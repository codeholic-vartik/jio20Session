// Import with `const Sentry = require("@sentry/nestjs");` if you are using CJS
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    // Environment tag for filtering in Sentry dashboard
    environment: process.env.NODE_ENV || 'development',
    // Release tracking (optional, can be set via env)
    release: process.env.SENTRY_RELEASE,
  });

  console.log('[Sentry] Error tracking initialized');
} else {
  console.log('[Sentry] DSN not configured, skipping initialization');
}

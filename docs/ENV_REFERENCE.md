## Environment Reference

- NODE_ENV: development | test | production
- PORT: HTTP port (default 9000)
- LOG_LEVEL: pino log level
- DATABASE_URL: PostgreSQL connection URL
- REDIS_URL: Redis for caching and sockets
- REDIS_BULLMQ_URL: Redis for BullMQ (optional, falls back to REDIS_URL)
- REDIS_DB: Redis database index for general usage (default 0)
- REDIS_BULLMQ_DB: Redis database index for BullMQ connections (optional, defaults to REDIS_DB)
- SENTRY_DSN: Sentry DSN (optional, enables error tracking and performance monitoring)
- SENTRY_RELEASE: Sentry release version (optional, for release tracking)
- SENTRY_TRACES_SAMPLE_RATE: Sentry traces sample rate (0.0 to 1.0, optional). Controls percentage of transactions sent to Sentry. Default: 0.1 (10%) in production, 1.0 (100%) in development.
- WEBSOCKET_NAMESPACE: Socket.IO namespace path (default /ws/v1/session/)

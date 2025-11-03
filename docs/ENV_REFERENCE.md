## Environment Reference

- NODE_ENV: development | test | production
- PORT: HTTP port (default 9000)
- LOG_LEVEL: pino log level
- DATABASE_URL: PostgreSQL connection URL
- REDIS_URL: Redis for caching and sockets
- REDIS_BULLMQ_URL: Redis for BullMQ (optional, falls back to REDIS_URL)
- SENTRY_DSN: Sentry DSN (optional)
- WEBSOCKET_NAMESPACE: Socket.IO namespace path (default /ws/v1/session/)

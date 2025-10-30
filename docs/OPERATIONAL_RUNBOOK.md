## Operational Runbook

- Health: GET /health
- Metrics: GET /metrics (Prometheus format)
- Logs: JSON via pino, include requestId
- Queues: BullMQ `session-jobs`
- Graceful shutdown: SIGTERM triggers Nest + Prisma + Redis close



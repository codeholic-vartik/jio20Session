## Architecture Overview

- NestJS + Fastify for HTTP
- Socket.IO with Redis adapter for horizontal scale
- PostgreSQL via Prisma, pooled by PgBouncer (infra)
- Redis for cache, pub/sub; separate Redis for BullMQ queues
- Observability: /health, /metrics (Prometheus), Sentry
- Security: Helmet, CORS, rate-limits



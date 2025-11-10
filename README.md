## Jio20 Session Platform

Backend services for managing live session lifecycles, real-time engagement, and sales synchronization for the Jio20 experience. Built with NestJS, BullMQ, Prisma, and Redis to deliver resilient background processing and websocket updates.

## Features

- Session lifecycle orchestration (creation, rotation, live transitions)
- Redis-driven pub/sub for participant and sales updates
- BullMQ workers with configurable batch processing (`sync-sales` handler)
- Prisma-powered Postgres integration with multi-schema support
- WebSocket gateway for pushing real-time session metrics

## Getting Started

```bash
# install dependencies
npm install

# run database migrations if needed
npx prisma migrate deploy

# development server
npm run start:dev

# production build
npm run build && npm run start:prod
```

## Configuration

Set the following environment variables (see `src/common/config/config.module.ts` for validation):

| Variable                        | Description                                      | Default              |
| ------------------------------- | ------------------------------------------------ | -------------------- |
| `DATABASE_URL`                  | Postgres connection string                       | —                    |
| `REDIS_URL`                     | Redis connection for pub/sub                     | —                    |
| `REDIS_BULLMQ_URL`              | Dedicated Redis connection for BullMQ (optional) | `REDIS_URL` fallback |
| `SESSION_SYNC_SALES_BATCH_SIZE` | Batch size for sales sync worker (1-1000)        | `50`                 |
| `LOG_LEVEL`                     | Application log level                            | `info`               |
| `WEBSOCKET_NAMESPACE`           | Namespace for socket gateway                     | `/ws/v1/session/`    |

Create a `.env` file at the project root:

```env
DATABASE_URL=postgresql://user:pass@host:5432/db?schema=session
REDIS_URL=redis://localhost:6379
SESSION_SYNC_SALES_BATCH_SIZE=100
```

## Project Structure

- `src/app/jobs/` – BullMQ queues, workers, and job handlers
- `src/app/session/` – Session REST APIs and business logic
- `src/app/socket/` – WebSocket adapters and gateways
- `src/common/` – Shared configuration, logging, and utilities
- `prisma/` – Prisma schema and database migrations

## Development Scripts

```bash
# run unit tests
npm run test

# e2e test suite
npm run test:e2e

# lint and format
npm run lint
npm run format
```

## Developer

- Author: Vartik Anand

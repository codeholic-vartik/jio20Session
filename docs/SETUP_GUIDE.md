## Setup Guide

1. Copy `.env.example` to `.env` and set values.
2. Install dependencies: `npm install`.
3. Generate Prisma client: `npx prisma generate`.
4. Run migrations: `npx prisma migrate dev`.
5. Ensure PostgreSQL and Redis are running and reachable (local installs or managed instances).
6. Start app: `npm run start:dev`.

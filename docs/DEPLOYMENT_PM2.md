## PM2 Deployment

Use this guide to deploy the service on a host without Docker, managed by `pm2`.

1. Install dependencies on the server:
   ```bash
   npm install
   npm run build
   ```
2. Install `pm2` globally if it is not already available:
   ```bash
   npm install -g pm2
   ```
3. Export the required environment variables (or create a `.env` file and load it with your preferred shell tooling):
   ```bash
   export NODE_ENV=production
   export DATABASE_URL=postgresql://user:pass@host:5432/jio20_session
   export REDIS_URL=redis://host:6379
   export REDIS_BULLMQ_URL=redis://host:6380
   ```
4. Launch the application via `pm2`:
   ```bash
   pm2 start dist/main.js --name jio20-session --update-env
   ```
5. (Optional) Persist the process list and configure startup scripts:
   ```bash
   pm2 save
   pm2 startup
   ```
6. Monitor or manage the process as needed:
   ```bash
   pm2 status
   pm2 logs jio20-session
   pm2 restart jio20-session
   ```

Keep Postgres and Redis running independently (managed service or system packages). Update connection strings to match your environment before starting the service.

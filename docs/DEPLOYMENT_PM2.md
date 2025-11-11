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

## GitHub Actions Workflow

The repository provides `.github/workflows/deploy.yml` to automate PM2 deployments after lint and build checks succeed.

### Prerequisites

- The target server must have:
  - Git, Node.js (>=20), npm (>=10), and PM2 installed.
  - The repository cloned at the desired location (for example `/var/www/jio20-session`).
  - Environment variables configured (via `.env` or system service) for database and Redis connections.
- Configure SSH access for GitHub Actions using a deploy key or dedicated user.

### Required Secrets

Set the following repository secrets in GitHub:

- `SSH_HOST` – Hostname or IP of the deployment server.
- `SSH_PORT` – (optional) SSH port, defaults to `22`.
- `SSH_USER` – SSH username with permissions to manage the app.
- `SSH_KEY` – Private key (PEM) for the deployment user.
- `APP_DIR` – Absolute path to the project directory on the server (matches the clone location).
- `PM2_APP_NAME` – PM2 process name, for example `jio20-session`.
- `REPO_URL` – Repository clone URL (used if the workflow needs to bootstrap the checkout).

### How It Works

On pushes to `main` (or manual dispatch), the workflow:

1. Checks out the repository.
2. Installs dependencies with `npm ci`.
3. Runs `npm run lint` and `npm run build`.
4. Connects over SSH and runs the deploy commands inline:
   - Optionally bootstraps the repository on the server using `REPO_URL` if the folder does not exist.
   - Fetches the latest commit for the branch that triggered the workflow.
   - Installs production dependencies, builds the application, and reloads or starts the PM2 process.
   - Starts the process with `pm2 start npm --name <PM2_APP_NAME> -- run start` if it is not already running, otherwise restarts the existing process.

#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/html/codeholic_product/jio20session}"
APP_BRANCH="${APP_BRANCH:-develop}"
PM2_APP_NAME="${PM2_APP_NAME:-jio20-session}"
REPO_URL="${REPO_URL:-}"

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "[deploy] ERROR: REPO_URL is not set and repository does not exist at $APP_DIR" >&2
    exit 1
  fi
  echo "[deploy] Preparing application directory at $APP_DIR"
  mkdir -p "$APP_DIR"
  if [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    echo "[deploy] Cloning repository from $REPO_URL"
    git clone "$REPO_URL" "$APP_DIR"
  else
    echo "[deploy] ERROR: $APP_DIR exists but is not empty and lacks a Git repository" >&2
    exit 1
  fi
fi

cd "$APP_DIR"

echo "[deploy] Updating repository in $APP_DIR (branch: $APP_BRANCH)"
git fetch --prune origin
git checkout -B "$APP_BRANCH" "origin/$APP_BRANCH"

echo "[deploy] Installing production dependencies"
NODE_ENV=production npm ci

echo "[deploy] Building application"
npm run build

echo "[deploy] Reloading PM2 process: $PM2_APP_NAME"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    pm2 reload "$PM2_APP_NAME" --update-env
else
  pm2 start dist/main.js --name "$PM2_APP_NAME" --update-env
fi

pm2 save

echo "[deploy] Completed successfully"


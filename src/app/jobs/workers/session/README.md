# Session Worker Module

This module handles all session-related background jobs using BullMQ. It processes jobs asynchronously to manage session lifecycle, threshold monitoring, and sales synchronization.

## 📁 Folder Structure

```
session/
├── config/              # Configuration files
│   ├── redis.config.ts          # Redis connection setup
│   └── job-options.config.ts    # Default job options
├── utils/               # Utility functions
│   ├── redis-keys.util.ts       # Redis key generation helpers
│   └── session.util.ts          # Session utility functions
├── services/            # Business logic services
│   └── session-creation.service.ts  # Session creation logic
├── handlers/            # Job handlers
│   ├── rotate-session.handler.ts    # Rotate session job handler
│   ├── threshold-reached.handler.ts # Threshold reached job handler
│   └── sync-sales.handler.ts        # Sales sync job handler
├── session.worker.ts    # Main worker coordinator
└── README.md            # This file
```

## 🔄 Job Types

The worker processes the following job types:

### 1. `rotate-session`

- **Purpose**: Rotates/transitions sessions
- **Handler**: `handlers/rotate-session.handler.ts`
- **Status**: Currently returns success (placeholder for future implementation)

### 2. `threshold-reached`

- **Purpose**: Creates a new session when sales threshold is reached
- **Handler**: `handlers/threshold-reached.handler.ts`
- **Job Data**:
  ```typescript
  {
    sessionId: number | string;
    sessionProfileId: number | string;
  }
  ```
- **Process**:
  1. Validates session and profile IDs
  2. Marks session creation as started in Redis
  3. Creates new session via `session-creation.service.ts`
  4. Updates Redis with creation status
  5. Handles errors and retries

### 3. `sync-sales`

- **Purpose**: Syncs sales count from Redis to database
- **Handler**: `handlers/sync-sales.handler.ts`
- **Process**:
  1. Scans Redis for all `session:sales:*` keys
  2. Fetches corresponding sessions from database
  3. Updates `current_sales_count` if Redis value is higher
  4. Processes in batches for performance

### 4. `expire-session-coupons`

- **Purpose**: Marks remaining coupons as expired once a session finishes consuming all available slots (i.e., participant count reaches `max_slots` and the session is marked `COMPLETED`)
- **Handler**: `handlers/expire-session-coupons.handler.ts`
- **Job Data**:
  ```typescript
  {
    sessionId: number;
    sessionProfileId: number;
    salesCount?: number;
    reason?: 'threshold_reached' | 'sales_update' | string;
  }
  ```
- **Process**:
  1. Validates session/profile relationship and ensures session status is `COMPLETED`
  2. Processes coupons in configurable batches (default 500)
  3. Updates `status='expired'` and `is_valid=false` for remaining coupons
  4. Stops automatically when no pending coupons remain
  5. Batch size can be overridden via `SESSION_COUPON_EXPIRE_BATCH_SIZE` env variable
- **Trigger**: Automatically enqueued when the last slot is claimed (inside `apply-coupon` worker result)

## 🔧 Configuration

### Redis Connection

- **File**: `config/redis.config.ts`
- **Features**:
  - Automatic reconnection with exponential backoff
  - Error handling and logging
  - Connection event monitoring
  - Environment-based URL configuration

### Job Options

- **File**: `config/job-options.config.ts`
- **Default Settings**:
  - Retry attempts: 3
  - Backoff strategy: Exponential (2 seconds initial delay)

## 📝 Usage

### Adding a Job to Queue

```typescript
import { Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { defaultJobOptions } from './workers/session/session.worker';

// In your service/controller
constructor(@Inject('SESSION_QUEUE') private sessionQueue: Queue) {}

// Add threshold-reached job
await this.sessionQueue.add('threshold-reached', {
  sessionId: 123,
  sessionProfileId: 456,
}, defaultJobOptions);

// Add sync-sales job
await this.sessionQueue.add('sync-sales', {}, defaultJobOptions);
```

### Creating a New Job Handler

1. Create handler file in `handlers/` directory
2. Export async function with signature: `(job: Job, connection: IORedis) => Promise<any>`
3. Add route in `session.worker.ts`:

```typescript
if (job.name === 'your-job-name') {
  return handleYourJob(job, connection);
}
```

## 🗄️ Redis Keys

The module uses the following Redis key patterns:

- `session:creation:pending:{sessionProfileId}:{sessionId}` - Tracks session creation status
- `session:sales:{sessionId}` - Stores cumulative sales count per session

## 🔍 Error Handling

- All handlers include try-catch blocks
- Errors are logged with context
- Failed jobs are retried according to `defaultJobOptions`
- Redis keys are preserved on error for audit purposes

## 📊 Monitoring

- All operations are logged with appropriate log levels
- Redis connection events are monitored
- Job processing status is tracked
- Errors include stack traces for debugging

## 🔄 Integration

The worker is automatically started when `BullmqModule` is imported (via `app.module.ts`). The module imports `./workers/session/session.worker` to ensure the worker starts processing jobs.

## ⚠️ Important Notes

1. **Sales Sync**: The `sync-sales` job does NOT delete Redis keys - they persist for the session lifetime
2. **Session Creation**: When threshold is reached, the old session's Redis sales key is NOT deleted immediately - sync job handles it
3. **Retries**: Jobs are automatically retried on failure (3 attempts with exponential backoff)
4. **Batch Processing**: Sync operations use batch processing (50 items per batch) for performance

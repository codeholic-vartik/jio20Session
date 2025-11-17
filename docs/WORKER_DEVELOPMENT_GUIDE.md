# Worker Development Guide

This guide provides step-by-step instructions for adding a new BullMQ worker to the codebase. Follow this guide to create workers that process background jobs asynchronously.

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Step-by-Step Guide](#step-by-step-guide)
4. [File Structure](#file-structure)
5. [Configuration Files](#configuration-files)
6. [Handlers](#handlers)
7. [Services](#services)
8. [Utilities](#utilities)
9. [Integration](#integration)
10. [Best Practices](#best-practices)
11. [Testing](#testing)
12. [Troubleshooting](#troubleshooting)

## 🎯 Overview

Workers in this codebase use **BullMQ** to process background jobs asynchronously. Each worker:

- Listens to a specific queue name
- Routes jobs to appropriate handlers based on job type
- Handles errors and retries automatically
- Provides logging and monitoring
- Uses Redis for job queue storage

### Example: Session Worker

The existing `session` worker processes jobs for the `session-jobs` queue and handles:

- `rotate-session` - Session rotation/transition
- `threshold-reached` - Create new session when threshold is reached
- `sync-sales` - Sync sales counts from Redis to database
- `start-live` - Transition OPENING to LIVE at exact time
- `sync-opening-sessions` - Sync opening sessions periodically

## 🏗️ Architecture

```
┌─────────────────┐
│   Application   │
│   (NestJS)      │
└────────┬────────┘
         │ Adds jobs
         ▼
┌─────────────────┐
│  BullMQ Queue   │
│  (Redis-based)  │
└────────┬────────┘
         │ Consumes jobs
         ▼
┌─────────────────┐
│     Worker      │
│  (BullMQ)       │
└────────┬────────┘
         │ Routes to handler
         ▼
┌─────────────────┐
│    Handlers     │
│  (Business      │
│   Logic)        │
└─────────────────┘
```

## 📝 Step-by-Step Guide

### Step 1: Create Worker Directory Structure

Create a new directory for your worker under `src/app/jobs/workers/`:

```bash
mkdir -p src/app/jobs/workers/{your-worker-name}/{config,handlers,services,utils}
```

**Example:**

```bash
mkdir -p src/app/jobs/workers/notification/{config,handlers,services,utils}
```

### Step 2: Create Redis Configuration

Create `config/redis.config.ts`:

```typescript
/**
 * @fileoverview Redis connection configuration for {your-worker-name} worker
 * @description Creates and configures Redis connection with error handling,
 * automatic reconnection, and event monitoring for BullMQ worker
 */

import IORedis from 'ioredis';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { normalizeRedisUrl } from '../../../../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../../../../common/utils/redis-db.util';

const logger: StandaloneLogger = createStandaloneLogger('{YourWorker}Redis');

/**
 * Creates Redis connection with proper error handling and retry logic
 *
 * @returns {IORedis} Configured Redis connection instance
 */
export function createRedisConnection(): IORedis {
  const redisUrl = normalizeRedisUrl(
    process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || undefined,
  );

  const dbIndex = resolveRedisDbIndex(redisUrl || '', {
    envNames: ['REDIS_BULLMQ_DB', 'REDIS_DB'],
  });

  logger.info(
    `Creating Redis connection for worker with database index: ${dbIndex}`,
  );

  const connection = new IORedis(redisUrl, {
    db: dbIndex,
    maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 5000);
      logger.warn(
        `Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
      );
      return delay;
    },
    reconnectOnError: (err) => {
      const reconnectErrors = [
        'READONLY',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE',
        'Connection lost',
        'Connection closed',
      ];

      const shouldReconnect = reconnectErrors.some((errorType) =>
        err.message.includes(errorType),
      );

      if (shouldReconnect) {
        logger.warn(
          `Redis error detected (${err.message}), attempting reconnection...`,
        );
        return true;
      }

      return false;
    },
    enableReadyCheck: true,
    lazyConnect: false,
    enableOfflineQueue: true,
    connectTimeout: 10000,
    keepAlive: 30000,
  });

  // Event handlers
  connection.on('error', (err) => {
    logger.error(`Redis connection error: ${err.message}`);
  });

  connection.on('connect', () => {
    logger.info('Redis connection established');
  });

  connection.on('ready', () => {
    logger.info('Redis connection ready and operational');
  });

  connection.on('close', () => {
    logger.warn('Redis connection closed - will attempt to reconnect');
  });

  connection.on('reconnecting', (delay: number) => {
    logger.warn(`Redis reconnecting in ${delay}ms...`);
  });

  return connection;
}
```

### Step 3: Create Job Options Configuration

Create `config/job-options.config.ts`:

```typescript
/**
 * @fileoverview Default job options configuration for {your-worker-name} worker jobs
 * @description Defines default retry and backoff strategies for all worker jobs
 */

import { JobsOptions } from 'bullmq';

/**
 * Default job options for {your-worker-name} worker jobs
 *
 * @description
 * These options are applied to all jobs added to the queue unless
 * overridden when adding the job.
 *
 * @property {number} attempts - Number of retry attempts (default: 3)
 * @property {Object} backoff - Backoff configuration
 * @property {string} backoff.type - Backoff type: 'exponential'
 * @property {number} backoff.delay - Initial delay in ms (default: 2000)
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};
```

### Step 4: Create Job Handlers

Create handler files in `handlers/` directory. Each handler should:

1. Accept a `Job` parameter from BullMQ
2. Accept optional additional parameters (e.g., Redis connection)
3. Return a Promise with the result
4. Handle errors appropriately

**Example:** `handlers/send-email.handler.ts`

````typescript
/**
 * @fileoverview Send email job handler
 * @description Handles job that sends email notifications
 */

import { Job } from 'bullmq';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('SendEmailHandler');

/**
 * Handles send-email job
 *
 * @param {Job} job - BullMQ job instance containing job data
 * @returns {Promise<Object>} Result object with processing details
 *
 * @example
 * ```typescript
 * // Job data format:
 * {
 *   to: 'user@example.com',
 *   subject: 'Welcome',
 *   body: 'Welcome to our platform!'
 * }
 * ```
 */
export async function handleSendEmail(job: Job): Promise<{
  processed: boolean;
  success: boolean;
  emailId?: string;
  timestamp: string;
}> {
  const jobData = job.data as {
    to: string;
    subject: string;
    body: string;
  };

  const timestamp = new Date().toISOString();

  try {
    logger.info(
      `Processing send-email job - to=${jobData.to}, subject=${jobData.subject}`,
    );

    // Your business logic here
    // Example: await emailService.send(jobData.to, jobData.subject, jobData.body);

    logger.info(`Email sent successfully - to=${jobData.to}`);

    return {
      processed: true,
      success: true,
      timestamp,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    logger.error(
      `Failed to send email - to=${jobData.to}, error=${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );

    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}
````

### Step 5: Create Services (Optional)

If your worker needs complex business logic, create service files in `services/`:

**Example:** `services/email.service.ts`

```typescript
/**
 * @fileoverview Email service
 * @description Handles email sending logic
 */

import { createStandaloneLogger } from '../../../../../common/logger/logger.util';

const logger = createStandaloneLogger('EmailService');

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<{ success: boolean; emailId: string }> {
  // Your email sending logic here
  logger.info(`Sending email to ${to}`);

  // Return result
  return {
    success: true,
    emailId: 'email-123',
  };
}
```

### Step 6: Create Utilities (Optional)

Create utility functions in `utils/` if needed:

**Example:** `utils/redis-keys.util.ts`

```typescript
/**
 * @fileoverview Redis key utility functions
 * @description Provides functions to generate consistent Redis key patterns
 */

/**
 * Generates Redis key for email tracking
 *
 * @param {string} emailId - The email ID
 * @returns {string} Redis key
 */
export const getEmailTrackingKey = (emailId: string): string =>
  `email:tracking:${emailId}`;
```

### Step 7: Create Main Worker File

Create `{your-worker-name}.worker.ts`:

````typescript
/**
 * @fileoverview Main {your-worker-name} worker coordinator
 * @description BullMQ worker that processes {your-worker-name}-related background jobs
 *
 * This worker handles these types of jobs:
 * - send-email: Send email notifications
 * - process-notification: Process notification logic
 *
 * The worker automatically starts when this module is imported (via bullmq.module.ts)
 */

import { Worker } from 'bullmq';
import { createRedisConnection } from './config/redis.config';
import { handleSendEmail } from './handlers/send-email.handler';
// Import other handlers...
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../common/logger/logger.util';

// Create Redis connection for worker
const connection = createRedisConnection();
const logger: StandaloneLogger = createStandaloneLogger('{YourWorker}Worker');

// Log worker initialization
logger.info('{Your worker name} worker module loaded - initializing worker...');

/**
 * Main {your-worker-name} worker that processes jobs
 *
 * @description
 * BullMQ Worker instance that listens to the '{your-queue-name}' queue and routes
 * jobs to appropriate handlers based on job name.
 *
 * @constant {Worker} {yourWorkerName}Worker
 *
 * @example
 * ```typescript
 * // Worker automatically starts when imported
 * import './workers/{your-worker-name}/{your-worker-name}.worker';
 *
 * // To add a job:
 * import { Inject } from '@nestjs/common';
 * import { Queue } from 'bullmq';
 *
 * constructor(@Inject('{YOUR_QUEUE}') private queue: Queue) {}
 *
 * await this.queue.add('send-email', {
 *   to: 'user@example.com',
 *   subject: 'Welcome',
 *   body: 'Welcome!'
 * });
 * ```
 *
 * @jobTypes
 * - 'send-email': Routes to handleSendEmail
 * - 'process-notification': Routes to handleProcessNotification
 * - Unknown types: Returns { ok: true }
 */
logger.info('Creating BullMQ Worker for queue: {your-queue-name}');

export const {yourWorkerName}Worker = new Worker(
  '{your-queue-name}',
  async (job) => {
    logger.info(
      `Processing job: name=${job.name}, id=${job.id}, data=${JSON.stringify(job.data)}`,
    );

    try {
      let result;

      // Route to appropriate handler based on job name
      if (job.name === 'send-email') {
        result = await handleSendEmail(job);
      } else if (job.name === 'process-notification') {
        // result = await handleProcessNotification(job);
        result = { ok: true }; // Placeholder
      } else {
        // Default response for unknown job types
        result = { ok: true };
      }

      logger.info(
        `Job completed successfully: name=${job.name}, id=${job.id}, result=${JSON.stringify(result)}`,
      );
      return result as unknown;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Job failed: name=${job.name}, id=${job.id}, error=${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error; // Re-throw to trigger BullMQ retry mechanism
    }
  },
  {
    connection,
    limiter: {
      max: 10, // Process up to 10 jobs concurrently
      duration: 1000, // Per second
    },
    concurrency: 5, // Process up to 5 jobs concurrently
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
);

// Add event handlers for worker lifecycle and job processing
{yourWorkerName}Worker.on('completed', (job) => {
  logger.info(`Worker event: Job completed - name=${job.name}, id=${job.id}`);
});

{yourWorkerName}Worker.on('failed', (job, err) => {
  logger.error(
    `Worker event: Job failed - name=${job?.name}, id=${job?.id}, error=${err.message}`,
    err.stack,
  );
});

{yourWorkerName}Worker.on('active', (job) => {
  logger.info(
    `Worker event: Job started processing - name=${job.name}, id=${job.id}`,
  );
});

{yourWorkerName}Worker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`, err.stack);
});

{yourWorkerName}Worker.on('ready', () => {
  logger.info('{Your worker name} worker is ready and listening for jobs');
});

{yourWorkerName}Worker.on('stalled', (jobId) => {
  logger.warn(`Worker event: Job stalled - id=${jobId}`);
});

{yourWorkerName}Worker.on('closing', () => {
  logger.info('{Your worker name} worker is closing');
});

/**
 * Default job options for {your-worker-name} jobs
 *
 * @description
 * Re-exported for convenience. Use when adding jobs to the queue.
 *
 * @example
 * ```typescript
 * import { defaultJobOptions } from './workers/{your-worker-name}/{your-worker-name}.worker';
 *
 * await queue.add('send-email', data, defaultJobOptions);
 * ```
 */
export { defaultJobOptions } from './config/job-options.config';
````

### Step 8: Register Queue in BullMQ Module

Update `src/app/jobs/bullmq.module.ts`:

1. **Import your worker** (to auto-start it):

```typescript
import './workers/{your-worker-name}/{your-worker-name}.worker'; // Ensure worker auto-starts
```

2. **Add queue provider**:

```typescript
{
  provide: '{YOUR_QUEUE}',
  useFactory: (connection: IORedis): Queue =>
    new Queue('{your-queue-name}', { connection }),
  inject: ['BULLMQ_CONNECTION'],
},
```

3. **Export the queue**:

```typescript
exports: ['BULLMQ_CONNECTION', 'SESSION_QUEUE', '{YOUR_QUEUE}'],
```

4. **Inject in constructor** (if needed):

```typescript
constructor(
  @Inject('BULLMQ_CONNECTION') private readonly connection: IORedis,
  @Inject('SESSION_QUEUE') private readonly sessionQueue: Queue,
  @Inject('{YOUR_QUEUE}') private readonly {yourQueue}: Queue,
) {}
```

### Step 9: Create README Documentation

Create `README.md` in your worker directory:

````markdown
# {Your Worker Name} Worker Module

This module handles all {your-worker-name}-related background jobs using BullMQ.

## 📁 Folder Structure

```js
{your-worker-name}/
├── config/              # Configuration files
│   ├── redis.config.ts          # Redis connection setup
│   └── job-options.config.ts    # Default job options
├── utils/               # Utility functions
│   └── redis-keys.util.ts       # Redis key generation helpers
├── services/            # Business logic services
│   └── {service-name}.service.ts
├── handlers/            # Job handlers
│   ├── send-email.handler.ts
│   └── process-notification.handler.ts
├── {your-worker-name}.worker.ts    # Main worker coordinator
└── README.md            # This file
```
````

## 🔄 Job Types

The worker processes the following job types:

### 1. `send-email`

- **Purpose**: Sends email notifications
- **Handler**: `handlers/send-email.handler.ts`
- **Job Data**:
  ```typescript
  {
    to: string;
    subject: string;
    body: string;
  }
  ```

## 📝 Usage

### Adding a Job to Queue

```typescript
import { Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { defaultJobOptions } from './workers/{your-worker-name}/{your-worker-name}.worker';

constructor(@Inject('{YOUR_QUEUE}') private {yourQueue}: Queue) {}

await this.{yourQueue}.add('send-email', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Welcome!'
}, defaultJobOptions);
```

````

## 📁 File Structure

A complete worker should have this structure:

```js
{your-worker-name}/
├── config/
│   ├── redis.config.ts          # Redis connection configuration
│   └── job-options.config.ts     # Default job options
├── handlers/
│   ├── {job-type-1}.handler.ts  # Handler for job type 1
│   └── {job-type-2}.handler.ts  # Handler for job type 2
├── services/                     # Optional: Business logic services
│   └── {service-name}.service.ts
├── utils/                        # Optional: Utility functions
│   └── {utility-name}.util.ts
├── {your-worker-name}.worker.ts  # Main worker file
└── README.md                     # Documentation
````

## ⚙️ Configuration Files

### Redis Configuration (`config/redis.config.ts`)

- Creates Redis connection with error handling
- Automatic reconnection with exponential backoff
- Connection event monitoring
- Environment-based URL configuration

**Key Features:**

- Uses `REDIS_BULLMQ_URL` or `REDIS_URL` environment variable
- Database index from `REDIS_BULLMQ_DB` or `REDIS_DB`
- Automatic retry on connection failures
- Event logging for monitoring

### Job Options Configuration (`config/job-options.config.ts`)

- Defines default retry and backoff strategies
- Applied to all jobs unless overridden

**Default Settings:**

- Retry attempts: 3
- Backoff type: Exponential
- Initial delay: 2000ms

## 🎯 Handlers

Handlers are functions that process specific job types. Each handler:

1. **Accepts**: `Job` from BullMQ and optional parameters
2. **Returns**: Promise with result object
3. **Handles**: Errors and logging

### Handler Template

```typescript
import { Job } from 'bullmq';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('HandlerName');

export async function handleJobName(
  job: Job,
  // ... other parameters
): Promise<{
  processed: boolean;
  success: boolean;
  // ... other result fields
}> {
  const jobData = job.data as {
    // Define job data structure
  };

  try {
    logger.info(`Processing job: ${job.name}`);

    // Your business logic here

    return {
      processed: true,
      success: true,
      // ... other fields
    };
  } catch (error) {
    logger.error(
      `Job failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error; // Re-throw to trigger retry
  }
}
```

## 🔧 Services

Services contain reusable business logic that handlers can use. They should:

- Be pure functions when possible
- Handle their own error cases
- Return structured results
- Include logging

### Service Template

```typescript
import { createStandaloneLogger } from '../../../../../common/logger/logger.util';

const logger = createStandaloneLogger('ServiceName');

export async function serviceFunction(
  param1: string,
  param2: number,
): Promise<{ success: boolean; result?: any }> {
  try {
    logger.info(`Processing: ${param1}`);

    // Your business logic

    return { success: true, result: {} };
  } catch (error) {
    logger.error(`Service error: ${error}`);
    throw error;
  }
}
```

## 🛠️ Utilities

Utilities provide helper functions for common operations:

- Redis key generation
- Data transformation
- Validation
- Formatting

### Utility Template

```typescript
/**
 * Generates Redis key for specific purpose
 *
 * @param {string} id - Identifier
 * @returns {string} Redis key
 */
export const getKeyName = (id: string): string => `prefix:${id}`;
```

## 🔗 Integration

### 1. Import Worker in BullMQ Module

The worker auto-starts when imported:

```typescript
// src/app/jobs/bullmq.module.ts
import './workers/{your-worker-name}/{your-worker-name}.worker';
```

### 2. Register Queue Provider

```typescript
{
  provide: '{YOUR_QUEUE}',
  useFactory: (connection: IORedis): Queue =>
    new Queue('{your-queue-name}', { connection }),
  inject: ['BULLMQ_CONNECTION'],
},
```

### 3. Export Queue

```typescript
exports: ['BULLMQ_CONNECTION', 'SESSION_QUEUE', '{YOUR_QUEUE}'],
```

### 4. Use in Services/Controllers

```typescript
import { Inject } from '@nestjs/common';
import { Queue } from 'bullmq';

constructor(@Inject('{YOUR_QUEUE}') private {yourQueue}: Queue) {}

async someMethod() {
  await this.{yourQueue}.add('job-name', { data }, defaultJobOptions);
}
```

## ✅ Best Practices

### 1. Error Handling

- Always wrap business logic in try-catch
- Log errors with context
- Re-throw errors to trigger BullMQ retry
- Don't swallow errors silently

### 2. Logging

- Use structured logging with context
- Include job ID, job name, and relevant data
- Log at appropriate levels (info, warn, error)
- Include stack traces for errors

### 3. Job Data Validation

- Validate job data at the start of handlers
- Throw descriptive errors for invalid data
- Use TypeScript types for job data

### 4. Redis Keys

- Use consistent naming patterns
- Include expiration times where appropriate
- Document key patterns in README

### 5. Performance

- Use batch processing for bulk operations
- Set appropriate concurrency limits
- Monitor queue sizes and processing times

### 6. Testing

- Test handlers in isolation
- Mock external dependencies
- Test error scenarios
- Test retry logic

## 🧪 Testing

### Unit Testing Handlers

```typescript
import { Job } from 'bullmq';
import { handleSendEmail } from './handlers/send-email.handler';

describe('handleSendEmail', () => {
  it('should send email successfully', async () => {
    const mockJob = {
      name: 'send-email',
      id: '123',
      data: {
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test body',
      },
    } as Job;

    const result = await handleSendEmail(mockJob);

    expect(result.success).toBe(true);
    expect(result.processed).toBe(true);
  });
});
```

### Integration Testing

Test the full worker flow:

```typescript
import { Queue } from 'bullmq';
import { Test } from '@nestjs/testing';

describe('Worker Integration', () => {
  let queue: Queue;

  beforeEach(async () => {
    // Setup test queue
  });

  it('should process job end-to-end', async () => {
    const job = await queue.add('send-email', {
      to: 'test@example.com',
      subject: 'Test',
      body: 'Test',
    });

    // Wait for job to complete
    await job.waitUntilFinished();

    expect(job.returnvalue.success).toBe(true);
  });
});
```

## 🐛 Troubleshooting

### Worker Not Starting

1. Check that worker is imported in `bullmq.module.ts`
2. Verify Redis connection is working
3. Check logs for initialization errors
4. Ensure queue name matches in worker and module

### Jobs Not Processing

1. Verify queue name matches between producer and consumer
2. Check Redis connection status
3. Review worker logs for errors
4. Verify job data format matches handler expectations

### Jobs Failing Repeatedly

1. Check handler error logs
2. Verify job data is valid
3. Check external dependencies (DB, APIs, etc.)
4. Review retry configuration
5. Check if max retries exceeded

### Performance Issues

1. Adjust concurrency settings
2. Review limiter configuration
3. Check Redis performance
4. Monitor queue sizes
5. Consider batch processing

## 📚 Additional Resources

- [BullMQ Documentation](https://docs.bullmq.io/)
- [Redis Documentation](https://redis.io/docs/)
- [NestJS Documentation](https://docs.nestjs.com/)

## 🔍 Example: Complete Worker Implementation

See `src/app/jobs/workers/session/` for a complete reference implementation.

## 📝 Checklist

When creating a new worker, ensure:

- [ ] Worker directory structure created
- [ ] Redis configuration file created
- [ ] Job options configuration created
- [ ] Handlers implemented for all job types
- [ ] Services created (if needed)
- [ ] Utilities created (if needed)
- [ ] Main worker file created with routing
- [ ] Worker imported in `bullmq.module.ts`
- [ ] Queue provider registered in `bullmq.module.ts`
- [ ] Queue exported from `bullmq.module.ts`
- [ ] README documentation created
- [ ] Error handling implemented
- [ ] Logging implemented
- [ ] Tests written (unit and integration)
- [ ] Code reviewed

---

**Need Help?** Refer to the existing `session` worker implementation or reach out to the team.

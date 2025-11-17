/**
 * @fileoverview Main session worker coordinator
 * @description BullMQ worker that processes session-related background jobs
 *
 * This worker handles these types of jobs:
 * - rotate-session: Session rotation/transition
 * - threshold-reached: Create new session when threshold is reached
 * - sync-sales: Sync sales counts from Redis to database
 * - start-live: Transition OPENING to LIVE at exact time (start_time + duration)
 *
 * The worker automatically starts when this module is imported (via bullmq.module.ts)
 */

import { Worker } from 'bullmq';
import {
  createRedisConnection,
  createSalesSyncRedisConnection,
} from './config/redis.config';
import { handleRotateSession } from './handlers/rotate-session.handler';
import { handleThresholdReached } from './handlers/threshold-reached.handler';
import { handleSyncSales } from './handlers/sync-sales.handler';
import { handleStartLive } from './handlers/start-live.handler';
import { handleSyncOpeningSessions } from './handlers/sync-opening.handler';
import { handleOrphanCoupons } from './handlers/orphan-coupon-checker';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../common/logger/logger.util';

// Create Redis connection for worker
const connection = createRedisConnection();
// Create separate Redis connection for sales sync (uses REDIS_DB, not REDIS_BULLMQ_DB)
const salesSyncConnection = createSalesSyncRedisConnection();
const logger: StandaloneLogger = createStandaloneLogger('SessionWorker');

// Log worker initialization
logger.info('Session worker module loaded - initializing worker...');

/**
 * Main session worker that processes session-related jobs
 *
 * @description
 * BullMQ Worker instance that listens to the 'session-jobs' queue and routes
 * jobs to appropriate handlers based on job name. This is the entry point
 * for all session-related background processing.
 *
 * @constant {Worker} sessionWorker
 *
 * @example
 * ```typescript
 * // Worker automatically starts when imported
 * import './workers/session/session.worker';
 *
 * // To add a job:
 * import { Inject } from '@nestjs/common';
 * import { Queue } from 'bullmq';
 *
 * constructor(@Inject('SESSION_QUEUE') private queue: Queue) {}
 *
 * await this.queue.add('threshold-reached', {
 *   sessionId: 123,
 *   sessionProfileId: 456
 * });
 * ```
 *
 * @jobTypes
 * - 'rotate-session': Routes to handleRotateSession
 * - 'threshold-reached': Routes to handleThresholdReached
 * - 'sync-sales': Routes to handleSyncSales
 * - 'start-live': Routes to handleStartLive (transitions OPENING to LIVE at exact time)
 * - 'sync-opening-sessions': Routes to handleSyncOpeningSessions
 * - 'process-orphan-coupons': Routes to handleOrphanCoupons
 * - Unknown types: Returns { ok: true }
 */
// Initialize worker immediately
logger.info('Creating BullMQ Worker for queue: session-jobs');

export const sessionWorker = new Worker(
  'session-jobs',
  async (job) => {
    logger.info(
      `Processing job: name=${job.name}, id=${job.id}, data=${JSON.stringify(job.data)}`,
    );

    try {
      let result;

      // Route to appropriate handler based on job name
      if (job.name === 'rotate-session') {
        result = await handleRotateSession(job);
      } else if (job.name === 'threshold-reached') {
        result = await handleThresholdReached(job, connection);
      } else if (job.name === 'sync-sales') {
        // Use sales sync connection (REDIS_DB) instead of worker connection (REDIS_BULLMQ_DB)
        result = await handleSyncSales(job, salesSyncConnection);
      } else if (job.name === 'start-live') {
        result = await handleStartLive(job);
      } else if (job.name === 'sync-opening-sessions') {
        result = await handleSyncOpeningSessions(job);
      } else if (job.name === 'process-orphan-coupons') {
        result = await handleOrphanCoupons(job);
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
    // Enable processing of delayed jobs - these settings help ensure delayed jobs are processed
    limiter: {
      max: 2, // Process up to 2 jobs concurrently (reduced to prevent database connection exhaustion)
      duration: 1000, // Per second
    },
    // Worker settings for processing jobs
    // IMPORTANT: Reduced concurrency from 5 to 1 to prevent:
    // 1. Database connection pool exhaustion when multiple jobs run simultaneously
    // 2. Database deadlocks when sync-sales and sync-opening-sessions both update sessions table
    // 3. Prisma transaction timeouts due to lock contention
    // This ensures jobs run sequentially, preventing resource contention
    concurrency: 1, // Process 1 job at a time to avoid database lock contention
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
sessionWorker.on('completed', (job) => {
  logger.info(`Worker event: Job completed - name=${job.name}, id=${job.id}`);
});

sessionWorker.on('failed', (job, err) => {
  logger.error(
    `Worker event: Job failed - name=${job?.name}, id=${job?.id}, error=${err.message}`,
    err.stack,
  );
});

sessionWorker.on('active', (job) => {
  logger.info(
    `Worker event: Job started processing - name=${job.name}, id=${job.id}`,
  );
});

sessionWorker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`, err.stack);
});

sessionWorker.on('ready', () => {
  logger.info('Session worker is ready and listening for jobs');

  // Periodically log queue status to monitor delayed jobs
  setInterval(() => {
    (async () => {
      try {
        const Queue = (await import('bullmq')).Queue;
        const queue = new Queue('session-jobs', { connection });
        const waiting = await queue.getWaitingCount();
        const active = await queue.getActiveCount();
        const delayed = await queue.getDelayedCount();
        const completed = await queue.getCompletedCount();
        const failed = await queue.getFailedCount();

        if (delayed > 0 || waiting > 0 || active > 0) {
          logger.info(
            `Queue status: waiting=${waiting}, active=${active}, delayed=${delayed}, completed=${completed}, failed=${failed}`,
          );
        }

        await queue.close();
      } catch (error) {
        // Ignore errors in monitoring
        logger.debug(
          `Queue monitoring error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })().catch(() => {
      // Ignore unhandled promise rejections
    });
  }, 30000); // Check every 30 seconds
});

sessionWorker.on('stalled', (jobId) => {
  logger.warn(`Worker event: Job stalled - id=${jobId}`);
});

sessionWorker.on('closing', () => {
  logger.info('Session worker is closing');
});

/**
 * Default job options for session jobs
 *
 * @description
 * Re-exported for convenience. Use when adding jobs to the queue.
 *
 * @example
 * ```typescript
 * import { defaultJobOptions } from './workers/session/session.worker';
 *
 * await queue.add('threshold-reached', data, defaultJobOptions);
 * ```
 */
export { defaultJobOptions } from './config/job-options.config';

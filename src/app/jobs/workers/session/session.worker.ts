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
import { createRedisConnection } from './config/redis.config';
import { handleRotateSession } from './handlers/rotate-session.handler';
import { handleThresholdReached } from './handlers/threshold-reached.handler';
import { handleSyncSales } from './handlers/sync-sales.handler';
import { handleStartLive } from './handlers/start-live.handler';

// Create Redis connection for worker
const connection = createRedisConnection();

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
 * - Unknown types: Returns { ok: true }
 */
export const sessionWorker = new Worker(
  'session-jobs',
  async (job) => {
    // Route to appropriate handler based on job name
    if (job.name === 'rotate-session') {
      return handleRotateSession(job);
    }

    if (job.name === 'threshold-reached') {
      return handleThresholdReached(job, connection);
    }

    if (job.name === 'sync-sales') {
      return handleSyncSales(job, connection);
    }

    if (job.name === 'start-live') {
      return handleStartLive(job);
    }

    // Default response for unknown job types
    return Promise.resolve({ ok: true });
  },
  { connection },
);

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

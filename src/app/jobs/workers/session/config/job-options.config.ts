/**
 * @fileoverview Default job options configuration for session worker jobs
 * @description Defines default retry and backoff strategies for all session jobs
 */

import { JobsOptions } from 'bullmq';

/**
 * Default job options for session worker jobs
 *
 * @description
 * These options are applied to all jobs added to the session queue unless
 * overridden when adding the job. Includes:
 * - Retry attempts: 3 retries before marking as failed
 * - Backoff strategy: Exponential backoff starting at 2 seconds
 *
 * @example
 * ```typescript
 * import { defaultJobOptions } from './config/job-options.config';
 *
 * await queue.add('threshold-reached', data, defaultJobOptions);
 * ```
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

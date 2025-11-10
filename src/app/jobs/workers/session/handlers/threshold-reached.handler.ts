/**
 * @fileoverview Threshold reached job handler
 * @description Handles job that creates a new session when sales threshold is reached
 */

import { Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { getSessionCreationKey } from '../utils/redis-keys.util';
import { parseSessionId, parseSessionProfileId } from '../utils/session.util';
import { createSession } from '../services/session-creation.service';

const logger: StandaloneLogger = createStandaloneLogger(
  'ThresholdReachedHandler',
);

/**
 * Handles threshold-reached job
 *
 * @description
 * Processes jobs triggered when a session reaches its sales threshold.
 * This handler:
 * 1. Parses and validates session and profile IDs
 * 2. Marks session creation as started in Redis (isCreated: false)
 * 3. Creates a new session via session-creation.service
 * 4. Updates Redis with success status (isCreated: true)
 * 5. Handles errors and retries with proper Redis tracking
 *
 * @param {Job} job - BullMQ job instance containing job data
 * @param {IORedis} connection - Redis connection for tracking status
 * @returns {Promise<Object>} Result object with processing details
 * @returns {boolean} returns.processed - Whether job was processed
 * @returns {boolean} returns.success - Whether creation was successful
 * @returns {number} returns.sessionId - Original session ID
 * @returns {number} returns.sessionProfileId - Session profile ID
 * @returns {number} [returns.newSessionId] - ID of newly created session
 * @returns {string} returns.timestamp - Processing timestamp
 *
 * @throws {Error} If session or profile IDs are invalid
 * @throws {Error} If session creation fails (will trigger retry)
 *
 * @example
 * ```typescript
 * // Job data format:
 * {
 *   sessionId: 123,        // or "sess_123" or "123"
 *   sessionProfileId: 456  // or "prod_456" or "456"
 * }
 *
 * // Job is automatically routed here when job.name === 'threshold-reached'
 * const result = await handleThresholdReached(job, connection);
 * ```
 *
 * @redis
 * Creates/updates Redis key: `session:creation:pending:{profileId}:{sessionId}`
 * - Stores creation status, timestamps, and error information
 * - Expires after 1 hour
 * - Used for audit and retry tracking
 */
export async function handleThresholdReached(
  job: Job,
  connection: IORedis,
): Promise<{
  processed: boolean;
  success: boolean;
  sessionId: number;
  sessionProfileId: number;
  newSessionId?: number;
  timestamp: string;
}> {
  const jobData = job.data as {
    sessionId: number | string;
    sessionProfileId: number | string;
  };

  // Ensure IDs are numbers (handle both string and number inputs)
  const sessionId = parseSessionId(jobData.sessionId);
  const sessionProfileId = parseSessionProfileId(jobData.sessionProfileId);

  if (isNaN(sessionId) || isNaN(sessionProfileId)) {
    throw new Error(
      `Invalid job data: sessionId=${jobData.sessionId}, sessionProfileId=${jobData.sessionProfileId}`,
    );
  }

  const redisKey = getSessionCreationKey(sessionProfileId, sessionId);
  const timestamp = new Date().toISOString();

  try {
    // Mark session creation as started in Redis (isCreated: false)
    await connection.setex(
      redisKey,
      3600, // Expire after 1 hour if not cleared
      JSON.stringify({
        isCreated: false,
        timestamp,
        sessionId,
        sessionProfileId,
      }),
    );

    logger.info(
      `Processing threshold reached - session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
    );

    // Create the new session
    const result = await createSession(sessionId, sessionProfileId);

    // Mark as successfully created in Redis (isCreated: true)
    await connection.setex(
      redisKey,
      3600, // Keep for 1 hour for audit
      JSON.stringify({
        isCreated: true,
        timestamp,
        completedAt: new Date().toISOString(),
        sessionId,
        sessionProfileId,
        newSessionId: result.newSessionId,
      }),
    );

    // NOTE: We do NOT delete the old session's Redis sales key here
    // The sync job will handle syncing those sales to DB and then deleting the key
    // This ensures no sales data is lost if sync hasn't run yet
    logger.info(
      `Session created successfully - new_session_id=${result.newSessionId}, old session ${sessionId} Redis key will be handled by sync job`,
    );

    return Promise.resolve({
      processed: true,
      success: true,
      sessionId,
      sessionProfileId,
      newSessionId: result.newSessionId,
      timestamp,
    });
  } catch (error) {
    // Keep the Redis flag with isCreated: false so retry worker can pick it up
    // Don't delete it - let it expire naturally or be handled by retry worker
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    logger.error(
      `Failed to create session - session_id=${sessionId}, session_profile_id=${sessionProfileId}, error=${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );

    // Update Redis with error info but keep isCreated: false
    await connection.setex(
      redisKey,
      3600,
      JSON.stringify({
        isCreated: false,
        timestamp,
        error: errorMessage,
        sessionId,
        sessionProfileId,
        retryCount: (job.attemptsMade || 0) + 1,
      }),
    );

    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}

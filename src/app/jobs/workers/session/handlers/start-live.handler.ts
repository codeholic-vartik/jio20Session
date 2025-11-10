/**
 * @fileoverview Start live job handler
 * @description Handles transition of sessions from OPENING to LIVE status
 */

import { Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { startLiveSession } from '../../session-transition.helper';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('StartLiveHandler');
const prisma = new PrismaClient();

/**
 * Handles start-live job
 *
 * @description
 * Transitions session from OPENING to LIVE status. This allows users to start applying coupons.
 * Validates that:
 * - Session status is OPENING
 * - Session profile is active and not deleted
 * - No other LIVE session exists for the same profile (only one LIVE per profile)
 * Multiple profiles can each have a LIVE session simultaneously.
 *
 * @param {Job} job - BullMQ job instance containing sessionId
 * @returns {Promise<Object>} Result object indicating transition status
 * @returns {boolean} returns.transitioned - Whether transition was successful
 * @returns {number} returns.sessionId - Session ID that was transitioned
 * @returns {string} returns.message - Status message
 *
 * @example
 * ```typescript
 * // Job data format:
 * {
 *   sessionId: 123
 * }
 *
 * // Job is automatically routed here when job.name === 'start-live'
 * const result = await handleStartLive(job);
 * ```
 */
export async function handleStartLive(job: Job): Promise<{
  transitioned: boolean;
  sessionId: number;
  message: string;
}> {
  const jobData = job.data as { sessionId: number };

  if (!jobData.sessionId || typeof jobData.sessionId !== 'number') {
    throw new Error(`Invalid job data: sessionId=${jobData.sessionId}`);
  }

  const sessionId = jobData.sessionId;

  try {
    // Use the existing startLiveSession function which handles all validation
    // including: only one LIVE session per profile, but multiple profiles can each have LIVE
    const result = await startLiveSession(sessionId, prisma);

    if (result.success) {
      logger.info(
        `Session ${sessionId} transitioned from OPENING to LIVE successfully`,
      );
      return {
        transitioned: true,
        sessionId,
        message: result.message,
      };
    } else {
      logger.warn(
        `Session ${sessionId} transition to LIVE failed: ${result.message}`,
      );
      return {
        transitioned: false,
        sessionId,
        message: result.message,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to transition session ${sessionId} to LIVE: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}

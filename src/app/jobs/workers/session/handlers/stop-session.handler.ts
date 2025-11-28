/**
 * @fileoverview Stop session job handler
 * @description Handles stopping/completing live sessions based on trigger values
 */

import { Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { SessionStatus } from '../../../../../common/types/enums';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { setSessionRedisTTL } from '../utils/session-redis-ttl.util';

const logger: StandaloneLogger = createStandaloneLogger('StopSessionHandler');
const prisma = new PrismaClient();

/**
 * Handles stop-session job
 *
 * @description
 * Marks a session as COMPLETED if it's currently LIVE.
 * Updates the session status to COMPLETED and sets end_time to current time.
 *
 * @param {Job} job - BullMQ job instance containing sessionId
 * @returns {Promise<Object>} Result object indicating stop status
 * @returns {boolean} returns.stopped - Whether session was stopped
 * @returns {number} returns.sessionId - Session ID that was stopped
 * @returns {string} returns.message - Status message
 *
 */
export async function handleStopSession(job: Job): Promise<{
  stopped: boolean;
  sessionId: number;
  message: string;
}> {
  const jobData = job.data as { sessionId: number };

  if (!jobData.sessionId || typeof jobData.sessionId !== 'number') {
    throw new Error(`Invalid job data: sessionId=${jobData.sessionId}`);
  }

  const sessionId = jobData.sessionId;

  try {
    // Fetch the session to check its current status
    const session = await prisma.sessions.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        suid: true,
        session_profile_id: true,
      },
    });

    if (!session) {
      logger.warn(`Session ${sessionId} not found`);
      return {
        stopped: false,
        sessionId,
        message: `Session ${sessionId} not found`,
      };
    }

    // Only stop if session is LIVE
    if (session.status?.toLowerCase() !== SessionStatus.LIVE.valueOf()) {
      logger.warn(
        `Session ${sessionId} is not LIVE (current status: ${session.status}), skipping stop`,
      );
      return {
        stopped: false,
        sessionId,
        message: `Session ${sessionId} is not LIVE (current status: ${session.status})`,
      };
    }

    // Update session to TIME_REACHED status (stopped)
    const now = new Date();
    await prisma.sessions.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.TIME_REACHED,
        end_time: now,
        is_active: false,
        updated_at: now,
      },
    });

    logger.info(
      `Session ${sessionId} (${session.suid}) stopped and marked as TIME_REACHED`,
    );

    // Set TTL on Redis keys for this stopped session
    try {
      await setSessionRedisTTL(sessionId);
      logger.info(`Set TTL on Redis keys for stopped session ${sessionId}`);
    } catch (ttlError) {
      const ttlErrorMessage =
        ttlError instanceof Error ? ttlError.message : String(ttlError);
      logger.warn(
        `Failed to set TTL on Redis keys for session ${sessionId}: ${ttlErrorMessage}`,
      );
      // Don't fail the entire operation if TTL setting fails
    }

    return {
      stopped: true,
      sessionId,
      message: `Session ${sessionId} stopped and marked as TIME_REACHED`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to stop session ${sessionId}: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}

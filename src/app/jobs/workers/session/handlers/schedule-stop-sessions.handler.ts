/**
 * @fileoverview Schedule stop sessions job handler
 * @description Finds all live sessions and schedules stop jobs based on trigger values
 */

import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { SessionStatus } from '../../../../../common/types/enums';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { calculateDelayMs } from '../../session-transition.helper';
import { createRedisConnection } from '../config/redis.config';

const logger: StandaloneLogger = createStandaloneLogger(
  'ScheduleStopSessionsHandler',
);
const prisma = new PrismaClient();

/**
 * Calculates the end time for a session based on start time and trigger values
 *
 * @param startTime - Session start time
 * @param startTriggerValue - Start trigger value
 * @param startTriggerType - Start trigger type (unit)
 * @param stopTriggerValue - Stop trigger value
 * @param stopTriggerType - Stop trigger type (unit)
 * @returns Calculated end time or null if invalid
 */
function calculateEndTime(
  startTime: Date | null,
  startTriggerValue: number | null,
  startTriggerType: string | null,
  stopTriggerValue: number | null,
  stopTriggerType: string | null,
): Date | null {
  if (!startTime) {
    return null;
  }

  const endTime = new Date(startTime);

  // Add start trigger value
  if (startTriggerValue && startTriggerType) {
    const startDelayMs = calculateDelayMs(startTriggerValue, startTriggerType);
    if (startDelayMs !== null) {
      endTime.setTime(endTime.getTime() + startDelayMs);
    }
  }

  // Add stop trigger value
  if (stopTriggerValue && stopTriggerType) {
    const stopDelayMs = calculateDelayMs(stopTriggerValue, stopTriggerType);
    if (stopDelayMs !== null) {
      endTime.setTime(endTime.getTime() + stopDelayMs);
    }
  }

  return endTime;
}

/**
 * Handles schedule-stop-sessions job
 *
 * @description
 * Finds all sessions with status LIVE and schedules stop jobs for them.
 * Calculates end time as: start_time + start_trigger_value + stop_trigger_value
 * Schedules a stop-session job for each live session at the calculated end time.
 *
 * @param {Job} job - BullMQ job instance
 * @returns {Promise<Object>} Result object with scheduling status
 * @returns {number} returns.checked - Number of live sessions found
 * @returns {number} returns.scheduled - Number of stop jobs scheduled
 * @returns {number} returns.skipped - Number of sessions skipped (invalid config)
 * @returns {number} returns.errors - Number of errors encountered
 *
 */
export async function handleScheduleStopSessions(): Promise<{
  checked: number;
  scheduled: number;
  skipped: number;
  errors: number;
}> {
  let checked = 0;
  let scheduled = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Create queue connection for scheduling jobs
    const queueConnection = createRedisConnection();
    const sessionQueue = new Queue('session-jobs', {
      connection: queueConnection,
    });

    // Find all LIVE sessions
    const liveSessions = await prisma.sessions.findMany({
      where: {
        status: {
          equals: SessionStatus.LIVE.valueOf(),
          mode: 'insensitive',
        },
        is_deleted: false,
      },
      select: {
        id: true,
        suid: true,
        start_time: true,
        start_trigger_type: true,
        start_trigger_value: true,
        stop_trigger_type: true,
        stop_trigger_value: true,
      },
    });

    checked = liveSessions.length;

    if (checked === 0) {
      logger.info('No LIVE sessions found to schedule stop jobs');
      return { checked, scheduled, skipped, errors };
    }

    logger.info(`Found ${checked} LIVE session(s) to schedule stop jobs`);

    const now = new Date();

    for (const session of liveSessions) {
      try {
        // Calculate end time: start_time + start_trigger_value + stop_trigger_value
        const endTime = calculateEndTime(
          session.start_time,
          session.start_trigger_value,
          session.start_trigger_type,
          session.stop_trigger_value,
          session.stop_trigger_type,
        );

        if (!endTime) {
          skipped++;
          logger.warn(
            `Session ${session.id} (${session.suid}) skipped: invalid trigger configuration (start_time=${session.start_time?.toISOString()}, start_trigger=${session.start_trigger_value} ${session.start_trigger_type}, stop_trigger=${session.stop_trigger_value} ${session.stop_trigger_type})`,
          );
          continue;
        }

        // Calculate delay from now to end time
        // If end time is in the past, schedule immediately (0 delay)
        const delayMs = Math.max(0, endTime.getTime() - now.getTime());

        // Use unique job ID to prevent duplicate jobs
        const jobId = `stop-session-${session.id}`;

        // Remove any existing job with the same ID first
        try {
          const existingJob = await sessionQueue.getJob(jobId);
          if (existingJob) {
            await existingJob.remove();
            logger.debug(
              `Removed existing stop-session job for session ${session.id}`,
            );
          }
        } catch (removeError) {
          // Ignore errors when removing (job might not exist)
          logger.debug(
            `No existing job to remove for session ${session.id}: ${removeError instanceof Error ? removeError.message : String(removeError)}`,
          );
        }

        // Schedule the stop job
        await sessionQueue.add(
          'stop-session',
          { sessionId: session.id },
          {
            jobId,
            delay: delayMs,
            attempts: 3,
            backoff: { type: 'exponential' as const, delay: 2000 },
            removeOnComplete: {
              age: 3600, // Keep completed jobs for 1 hour
            },
          },
        );

        scheduled++;
        logger.info(
          `Scheduled stop job for session ${session.id} (${session.suid}): endTime=${endTime.toISOString()}, delayMs=${delayMs} (${(delayMs / 1000).toFixed(0)}s, ${(delayMs / (1000 * 60)).toFixed(2)}min, ${(delayMs / (1000 * 60 * 60)).toFixed(2)}h)`,
        );
      } catch (error) {
        errors++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Error scheduling stop job for session ${session.id}: ${errorMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    logger.info(
      `Schedule stop sessions completed: checked=${checked}, scheduled=${scheduled}, skipped=${skipped}, errors=${errors}`,
    );

    return { checked, scheduled, skipped, errors };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle database connection errors gracefully
    const isDatabaseConnectionError =
      error instanceof Error &&
      (error.constructor.name === 'PrismaClientInitializationError' ||
        errorMessage.includes("Can't reach database server") ||
        errorMessage.includes('P1001') ||
        errorMessage.includes('connection'));

    if (isDatabaseConnectionError) {
      logger.warn(
        `Database connection unavailable: ${errorMessage}. Please ensure the database server is running.`,
      );
      return { checked: 0, scheduled: 0, skipped: 0, errors: 1 };
    }

    logger.error(
      `Failed to schedule stop sessions: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error;
  }
}

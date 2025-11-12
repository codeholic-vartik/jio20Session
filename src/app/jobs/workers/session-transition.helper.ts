import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { SessionStatus } from '../../../common/types/enums';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('SessionTransition');

/**
 * Calculates delay in milliseconds based on duration value and unit
 * Supports: seconds, minutes, hours, days, years (both singular and plural, case-insensitive)
 */
export function calculateDelayMs(
  durationValue: number | null,
  durationUnit: string | null,
): number | null {
  if (!durationValue || !durationUnit) {
    return null;
  }

  // Normalize unit: handle both singular and plural, case-insensitive
  const unit = durationUnit.toLowerCase().trim();

  switch (unit) {
    case 'seconds':
    case 'second':
      return durationValue * 1000;
    case 'minutes':
    case 'minute':
      return durationValue * 60 * 1000;
    case 'hours':
    case 'hour':
      return durationValue * 60 * 60 * 1000;
    case 'days':
    case 'day':
      return durationValue * 24 * 60 * 60 * 1000;
    case 'years':
    case 'year':
      return durationValue * 365 * 24 * 60 * 60 * 1000; // Approximate year
    default:
      return null;
  }
}

/**
 * Transitions session from OPENING to LIVE status
 * This allows users to start applying coupons
 * Validates that:
 * - Session status is OPENING
 * - Session profile is active and not deleted
 * - No other LIVE session exists for the same profile
 */
export async function startLiveSession(
  sessionId: number,
  prisma: PrismaClient,
): Promise<{ success: boolean; message: string }> {
  const session = await prisma.sessions.findUnique({
    where: { id: sessionId },
    include: {
      session_profiles: {
        select: {
          id: true,
          is_active: true,
          is_deleted: true,
          session_duration_value: true,
          session_duration_unit: true,
        },
      },
    },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Check if session profile exists and get profile data
  const sessionProfile = session.session_profiles;
  if (!sessionProfile) {
    logger.warn(
      `Session ${sessionId} has no associated profile, skipping transition`,
    );
    return {
      success: false,
      message: `Session ${sessionId} has no associated profile`,
    };
  }

  // Validate session profile is active
  if (!sessionProfile.is_active) {
    logger.warn(
      `Session profile ${sessionProfile.id} is not active for session ${sessionId}, skipping transition`,
    );
    return {
      success: false,
      message: `Session profile ${sessionProfile.id} is not active`,
    };
  }

  // Validate session profile is not deleted
  if (sessionProfile.is_deleted) {
    logger.warn(
      `Session profile ${sessionProfile.id} is deleted for session ${sessionId}, skipping transition`,
    );
    return {
      success: false,
      message: `Session profile ${sessionProfile.id} is deleted`,
    };
  }

  // Only transition if status is OPENING (case-insensitive to support legacy data)
  const sessionStatus = session.status?.toLowerCase();
  if (sessionStatus !== SessionStatus.OPENING.valueOf()) {
    logger.warn(
      `Session ${sessionId} is not in OPENING status (current: ${session.status}), skipping transition`,
    );
    return {
      success: false,
      message: `Session is not in OPENING status (current: ${session.status})`,
    };
  }

  // Check if there's already a LIVE session for this profile
  const existingLiveSession = await prisma.sessions.findFirst({
    where: {
      session_profile_id: session.session_profile_id,
      status: {
        equals: SessionStatus.LIVE.valueOf(),
        mode: 'insensitive',
      },
      is_deleted: false,
      id: {
        not: sessionId, // Exclude current session
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (existingLiveSession) {
    logger.warn(
      `Cannot transition session ${sessionId} to LIVE: Session profile ${session.session_profile_id} already has a LIVE session (session ${existingLiveSession.id}: ${existingLiveSession.name}). Skipping auto-start.`,
    );
    return {
      success: false,
      message: `Session profile ${session.session_profile_id} already has a LIVE session (session ${existingLiveSession.id}). Cannot start another LIVE session automatically.`,
    };
  }

  // Update session status to LIVE
  await prisma.sessions.update({
    where: { id: sessionId },
    data: {
      status: SessionStatus.LIVE.valueOf(),
      updated_at: new Date(),
    },
  });

  logger.info(
    `Session ${sessionId} transitioned from OPENING to LIVE - users can now apply coupons`,
  );

  return {
    success: true,
    message: `Session ${sessionId} is now LIVE - coupon application enabled`,
  };
}

/**
 * Job options for start-live transition job
 */
const START_LIVE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: {
    age: 3600, // Keep completed jobs for 1 hour
  },
} as const;

/**
 * Schedules a job to transition session from OPENING to LIVE at exact time
 * Calculates exact time as: start_time + duration
 *
 * @param sessionId - Session ID to transition
 * @param startTime - Session start_time (preserve scheduled time)
 * @param durationValue - Duration value from profile
 * @param durationUnit - Duration unit from profile
 * @param sessionQueue - Queue instance for scheduling
 */
export async function scheduleStartLiveJob(
  sessionId: number,
  startTime: Date | null,
  durationValue: number | null,
  durationUnit: string | null,
  sessionQueue: Queue,
): Promise<void> {
  // Calculate exact time when session should go LIVE: start_time + duration
  const expectedLiveTime = calculateExpectedLiveTime(
    startTime,
    durationValue,
    durationUnit,
  );

  if (!expectedLiveTime) {
    logger.warn(
      `Cannot schedule start-live job for session ${sessionId}: invalid start_time or duration configuration`,
    );
    return;
  }

  const now = new Date();
  // Calculate delay from now to expected live time
  // If expected time is in the past, schedule immediately (0 delay)
  const delayMs = Math.max(0, expectedLiveTime.getTime() - now.getTime());

  // Use unique job ID to prevent duplicate jobs
  const jobId = `start-live-${sessionId}`;

  // Log scheduling details for debugging
  logger.info(
    `Scheduling start-live job for session ${sessionId}: startTime=${startTime?.toISOString()}, duration=${durationValue} ${durationUnit}, expectedLiveTime=${expectedLiveTime.toISOString()}, delayMs=${delayMs}, delayHours=${(delayMs / (1000 * 60 * 60)).toFixed(2)}`,
  );

  try {
    // Remove any existing job with the same ID first to avoid conflicts
    try {
      const existingJob = await sessionQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
        logger.info(
          `Removed existing start-live job for session ${sessionId} before scheduling new one`,
        );
      }
    } catch (removeError) {
      // Ignore errors when removing (job might not exist)
      logger.debug(
        `No existing job to remove for session ${sessionId}: ${removeError instanceof Error ? removeError.message : String(removeError)}`,
      );
    }

    const job = await sessionQueue.add(
      'start-live',
      { sessionId },
      {
        jobId,
        delay: delayMs,
        ...START_LIVE_JOB_OPTIONS,
      },
    );

    // Verify job was created and get its state
    const jobState = await job.getState();
    const jobDelay = job.opts?.delay || 0;

    logger.info(
      `Successfully scheduled start-live job for session ${sessionId}: jobId=${job.id}, state=${jobState}, expectedExecutionTime=${expectedLiveTime.toISOString()}, delayMs=${delayMs} (${(delayMs / 1000).toFixed(0)}s, ${(delayMs / (1000 * 60)).toFixed(2)}min, ${(delayMs / (1000 * 60 * 60)).toFixed(2)}h), jobDelay=${jobDelay}ms`,
    );

    // Additional verification: check if job exists in waiting/delayed state
    if (delayMs > 0) {
      const waitingCount = await sessionQueue.getWaitingCount();
      const delayedCount = await sessionQueue.getDelayedCount();
      logger.info(
        `Queue status for session ${sessionId}: waiting=${waitingCount}, delayed=${delayedCount}`,
      );
    }
  } catch (scheduleError) {
    const errorMessage =
      scheduleError instanceof Error
        ? scheduleError.message
        : String(scheduleError);
    const errorStack =
      scheduleError instanceof Error ? scheduleError.stack : undefined;

    logger.error(
      `Failed to schedule start-live job for session ${sessionId}: ${errorMessage}`,
      errorStack,
    );
    // Don't throw - allow session creation to continue
  }
}

/**
 * Calculates the expected transition time from OPENING to LIVE
 * All times are in UTC - startTime is UTC, result is UTC
 */
function calculateExpectedLiveTime(
  startTime: Date | null,
  durationValue: number | null,
  durationUnit: string | null,
): Date | null {
  if (!startTime || !durationValue || !durationUnit) {
    return null;
  }

  // startTime is already UTC (JavaScript Date is UTC internally)
  // Create a new Date object from the UTC timestamp to ensure UTC calculations
  const expectedTime = new Date(startTime);
  // Normalize unit: handle both singular and plural, case-insensitive
  const unit = durationUnit.toLowerCase().trim();

  // Handle both singular and plural forms
  switch (unit) {
    case 'minutes':
    case 'minute':
      expectedTime.setMinutes(expectedTime.getMinutes() + durationValue);
      break;
    case 'hours':
    case 'hour':
      expectedTime.setHours(expectedTime.getHours() + durationValue);
      break;
    case 'days':
    case 'day':
      expectedTime.setDate(expectedTime.getDate() + durationValue);
      break;
    case 'years':
    case 'year':
      expectedTime.setFullYear(expectedTime.getFullYear() + durationValue);
      break;
    case 'seconds':
    case 'second':
      expectedTime.setSeconds(expectedTime.getSeconds() + durationValue);
      break;
    default:
      return null;
  }

  return expectedTime;
}

/**
 * Syncs OPENING sessions to LIVE status if they should be LIVE
 * This acts as a fallback mechanism to ensure sessions transition properly
 */
export async function syncOpeningSessionsToLive(prisma: PrismaClient): Promise<{
  checked: number;
  transitioned: number;
  skipped: number;
  errors: number;
}> {
  let checked = 0;
  let transitioned = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Find all OPENING sessions
    const openingSessions = await prisma.sessions.findMany({
      where: {
        status: {
          equals: SessionStatus.OPENING.valueOf(),
          mode: 'insensitive',
        },
        is_deleted: false,
      },
      include: {
        session_profiles: {
          select: {
            id: true,
            is_active: true,
            is_deleted: true,
            session_duration_value: true,
            session_duration_unit: true,
          },
        },
      },
    });

    checked = openingSessions.length;

    if (checked === 0) {
      logger.debug('No OPENING sessions found to sync');
      return { checked, transitioned, skipped, errors };
    }

    logger.info(`Checking ${checked} OPENING sessions for transition to LIVE`);

    const now = new Date();

    for (const session of openingSessions) {
      try {
        // Skip if no profile or profile is inactive/deleted
        if (
          !session.session_profiles ||
          !session.session_profiles.is_active ||
          session.session_profiles.is_deleted
        ) {
          skipped++;
          logger.debug(`Session ${session.id} skipped: no active profile`);
          continue;
        }

        const profile = session.session_profiles;

        // Calculate expected transition time
        const expectedLiveTime = calculateExpectedLiveTime(
          session.start_time,
          profile.session_duration_value,
          profile.session_duration_unit,
        );

        // Skip if we can't calculate expected time
        if (!expectedLiveTime) {
          skipped++;
          logger.debug(
            `Session ${session.id} skipped: invalid duration configuration`,
          );
          continue;
        }

        // Only transition if expected time has passed
        if (now < expectedLiveTime) {
          skipped++;
          logger.debug(
            `Session ${session.id} skipped: not yet time to transition (expected: ${expectedLiveTime.toISOString()})`,
          );
          continue;
        }

        // Attempt to transition to LIVE
        const result = await startLiveSession(session.id, prisma);

        if (result.success) {
          transitioned++;
          logger.info(`Synced session ${session.id} from OPENING to LIVE`);
        } else {
          skipped++;
          logger.debug(`Session ${session.id} skipped: ${result.message}`);
        }
      } catch (error) {
        errors++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Error syncing session ${session.id}: ${errorMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    logger.info(
      `Session sync completed: checked=${checked}, transitioned=${transitioned}, skipped=${skipped}, errors=${errors}`,
    );

    return { checked, transitioned, skipped, errors };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to sync opening sessions: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error;
  }
}

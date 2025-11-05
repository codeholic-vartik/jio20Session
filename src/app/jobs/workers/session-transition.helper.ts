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
 */
export function calculateDelayMs(
  durationValue: number | null,
  durationUnit: string | null,
): number | null {
  if (!durationValue || !durationUnit) {
    return null;
  }

  const unit = durationUnit.toLowerCase();
  switch (unit) {
    case 'minutes':
      return durationValue * 60 * 1000;
    case 'hours':
      return durationValue * 60 * 60 * 1000;
    case 'days':
      return durationValue * 24 * 60 * 60 * 1000;
    case 'years':
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

  // Only transition if status is OPENING
  if (session.status !== SessionStatus.OPENING.valueOf()) {
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
      status: SessionStatus.LIVE.valueOf(),
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
      status: SessionStatus.LIVE,
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
 * Validates duration configuration and calculates delay
 */
function validateAndCalculateDelay(
  sessionId: number,
  durationValue: number | null,
  durationUnit: string | null,
): number | null {
  const delayMs = calculateDelayMs(durationValue, durationUnit);

  if (delayMs === null) {
    logger.warn(
      `Cannot schedule start-live job for session ${sessionId}: invalid duration (value: ${durationValue}, unit: ${durationUnit})`,
    );
    return null;
  }

  return delayMs;
}

/**
 * Schedules a delayed job to transition session from OPENING to LIVE
 */
export async function scheduleStartLiveJob(
  sessionId: number,
  durationValue: number | null,
  durationUnit: string | null,
  sessionQueue: Queue,
): Promise<void> {
  const delayMs = validateAndCalculateDelay(
    sessionId,
    durationValue,
    durationUnit,
  );

  if (delayMs === null) {
    return;
  }

  try {
    await sessionQueue.add(
      'start-live',
      { sessionId },
      {
        delay: delayMs,
        ...START_LIVE_JOB_OPTIONS,
      },
    );

    logger.info(
      `Scheduled start-live job for session ${sessionId} with delay ${delayMs}ms (${durationValue} ${durationUnit})`,
    );
  } catch (scheduleError) {
    const errorMessage =
      scheduleError instanceof Error
        ? scheduleError.message
        : String(scheduleError);

    logger.error(
      `Failed to schedule start-live job for session ${sessionId}: ${errorMessage}`,
    );
    // Don't throw - allow session creation to continue
  }
}

/**
 * Calculates the expected transition time from OPENING to LIVE
 */
function calculateExpectedLiveTime(
  startTime: Date | null,
  durationValue: number | null,
  durationUnit: string | null,
): Date | null {
  if (!startTime || !durationValue || !durationUnit) {
    return null;
  }

  const expectedTime = new Date(startTime);
  const unit = durationUnit.toLowerCase();

  switch (unit) {
    case 'minutes':
      expectedTime.setMinutes(expectedTime.getMinutes() + durationValue);
      break;
    case 'hours':
      expectedTime.setHours(expectedTime.getHours() + durationValue);
      break;
    case 'days':
      expectedTime.setDate(expectedTime.getDate() + durationValue);
      break;
    case 'years':
      expectedTime.setFullYear(expectedTime.getFullYear() + durationValue);
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
        status: SessionStatus.OPENING.valueOf(),
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

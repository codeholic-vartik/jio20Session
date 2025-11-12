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
 * - No other LIVE session exists for the same profile (unless force-stopped)
 *
 * Priority: When multiple OPENING sessions exist for the same profile:
 * - Jobs are scheduled with delays based on start_time + duration
 * - Jobs execute in queue order (FIFO by execution time)
 * - First job to execute successfully becomes LIVE
 * - Subsequent jobs are blocked until the LIVE session ends or is force-stopped
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

  // Use a transaction to atomically check and update, preventing race conditions
  // This ensures only one session per profile can transition to LIVE at a time
  // Set timeout to 10 seconds to prevent hanging on locks
  let result: { success: boolean; message: string };
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // Re-check session status and get session_profile_id within transaction (it might have changed)
        const currentSessionCheck = await tx.sessions.findUnique({
          where: { id: sessionId },
          select: { status: true, session_profile_id: true },
        });

        if (
          !currentSessionCheck ||
          currentSessionCheck.status?.toLowerCase() !==
            SessionStatus.OPENING.valueOf()
        ) {
          return {
            success: false,
            message: `Session ${sessionId} is no longer in OPENING status`,
          };
        }

        if (!currentSessionCheck.session_profile_id) {
          return {
            success: false,
            message: `Session ${sessionId} has no associated profile`,
          };
        }

        // Check if there are any LIVE sessions for this profile
        // Only one LIVE session per profile is allowed, unless ALL existing LIVE sessions are force-stopped
        // We need to check ALL LIVE sessions, not just the first one, to prevent multiple LIVE sessions
        const allLiveSessions = await tx.$queryRaw<
          Array<{
            id: number;
            force_stop: boolean;
            status: string;
            name: string;
          }>
        >`
        SELECT id, force_stop, status, name
      FROM session.sessions 
        WHERE session_profile_id = ${currentSessionCheck.session_profile_id}
          AND LOWER(status) = LOWER(${SessionStatus.LIVE.valueOf()})
          AND is_deleted = false
          AND id != ${sessionId}
      `;

        if (allLiveSessions.length > 0) {
          // Check if ALL existing LIVE sessions are force-stopped or no longer LIVE
          const activeLiveSessions = allLiveSessions.filter(
            (session) =>
              session.force_stop !== true &&
              session.status?.toLowerCase() === SessionStatus.LIVE.valueOf(),
          );

          if (activeLiveSessions.length > 0) {
            // There's at least one active (non-force-stopped) LIVE session, block the transition
            const activeSessionIds = activeLiveSessions
              .map((s) => s.id)
              .join(', ');
            logger.warn(
              `Cannot transition session ${sessionId} to LIVE: Session profile ${currentSessionCheck.session_profile_id} already has ${activeLiveSessions.length} active LIVE session(s) (${activeSessionIds}) that are not force-stopped. Skipping auto-start.`,
            );
            return {
              success: false,
              message: `Session profile ${currentSessionCheck.session_profile_id} already has active LIVE session(s) (${activeSessionIds}). Cannot start another LIVE session automatically until all LIVE sessions end or are force-stopped.`,
            };
          } else {
            // All existing LIVE sessions are force-stopped or no longer LIVE, we can proceed
            const forceStoppedIds = allLiveSessions
              .filter((s) => s.force_stop === true)
              .map((s) => s.id)
              .join(', ');
            logger.info(
              `All existing LIVE session(s) (${forceStoppedIds || 'none'}) are force-stopped or no longer LIVE. Allowing transition of session ${sessionId} to LIVE.`,
            );
          }
        }

        // Use row-level locking (SELECT FOR UPDATE) to prevent race conditions
        // Lock all OPENING sessions for this profile to ensure only one transitions
        // This prevents multiple OPENING sessions from transitioning simultaneously
        // Note: Lock timeout is handled by transaction timeout (10 seconds)
        const openingSessionsLocked = await tx.$queryRaw<
          Array<{
            id: number;
            start_time: Date | null;
            created_at: Date | null;
          }>
        >`
        SELECT id, start_time, created_at
        FROM session.sessions
        WHERE session_profile_id = ${currentSessionCheck.session_profile_id}
          AND LOWER(status) = LOWER(${SessionStatus.OPENING.valueOf()})
          AND is_deleted = false
        ORDER BY start_time ASC NULLS LAST, created_at ASC NULLS LAST
        FOR UPDATE
      `;

        // Get current session's details
        const currentSessionFull = await tx.sessions.findUnique({
          where: { id: sessionId },
          select: { start_time: true, created_at: true },
        });

        if (!currentSessionFull) {
          return {
            success: false,
            message: `Session ${sessionId} not found`,
          };
        }

        // Find current session's position in the locked list
        const currentSessionIndex = openingSessionsLocked.findIndex(
          (s) => s.id === sessionId,
        );

        // Verify current session is still OPENING (found in locked rows)
        if (currentSessionIndex === -1) {
          return {
            success: false,
            message: `Session ${sessionId} is not in OPENING status or was not found in locked rows`,
          };
        }

        // Only allow the FIRST OPENING session (index 0) to transition
        // All other OPENING sessions must wait
        if (currentSessionIndex !== 0) {
          const firstSession = openingSessionsLocked[0];
          logger.warn(
            `Cannot transition session ${sessionId} to LIVE: Another OPENING session ${firstSession.id} has earlier start_time (position ${currentSessionIndex + 1} of ${openingSessionsLocked.length}). Only the first OPENING session should transition.`,
          );
          return {
            success: false,
            message: `Another OPENING session ${firstSession.id} has earlier start_time. Only the first OPENING session should transition to LIVE.`,
          };
        }

        // Final check: Ensure no other session has become LIVE while we were processing
        // This is a double-check to prevent race conditions
        const finalLiveCheck = await tx.$queryRaw<
          Array<{ id: number; force_stop: boolean; status: string }>
        >`
        SELECT id, force_stop, status
        FROM session.sessions
        WHERE session_profile_id = ${currentSessionCheck.session_profile_id}
          AND LOWER(status) = LOWER(${SessionStatus.LIVE.valueOf()})
          AND is_deleted = false
          AND id != ${sessionId}
          AND force_stop = false
      `;

        if (finalLiveCheck.length > 0) {
          const activeSessionIds = finalLiveCheck.map((s) => s.id).join(', ');
          logger.warn(
            `Cannot transition session ${sessionId} to LIVE: Another session(s) (${activeSessionIds}) became LIVE while processing. Blocking transition to prevent multiple LIVE sessions.`,
          );
          return {
            success: false,
            message: `Another session(s) (${activeSessionIds}) is already LIVE. Cannot start another LIVE session.`,
          };
        }

        // Update session status to LIVE within the transaction
        await tx.sessions.update({
          where: { id: sessionId },
          data: {
            status: SessionStatus.LIVE.valueOf(),
            updated_at: new Date(),
          },
        });

        return {
          success: true,
          message: `Session ${sessionId} is now LIVE - coupon application enabled`,
        };
      },
      {
        maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
        timeout: 10000, // Maximum time the transaction can run (10 seconds)
      },
    );
  } catch (transactionError) {
    // Handle transaction timeout or other transaction errors
    const errorMessage =
      transactionError instanceof Error
        ? transactionError.message
        : String(transactionError);
    logger.error(
      `Transaction failed for session ${sessionId}: ${errorMessage}`,
      transactionError instanceof Error ? transactionError.stack : undefined,
    );
    return {
      success: false,
      message: `Transaction failed: ${errorMessage}. This may be due to database locks or timeout.`,
    };
  }

  if (result.success) {
    logger.info(
      `Session ${sessionId} transitioned from OPENING to LIVE - users can now apply coupons`,
    );
  }

  return result;
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

  // Calculate priority: earlier start_time = higher priority (lower number)
  // This ensures if multiple sessions have same execution time, the one with earlier start_time executes first
  // BullMQ uses lower number = higher priority, and priority must be between 0 and 2097152
  // Normalize timestamp to fit in valid range while preserving relative ordering
  const MAX_PRIORITY = 2097152;
  let priority = 0;
  if (startTime) {
    // Use a reference time (epoch or fixed past date) to calculate relative priority
    // Earlier start times should get lower priority numbers (higher priority in BullMQ)
    // Scale the timestamp difference to fit in the valid priority range
    const referenceTime = new Date('2020-01-01T00:00:00Z'); // Fixed reference point
    const timeDiffMs = startTime.getTime() - referenceTime.getTime();
    // Convert to seconds and scale to fit in priority range
    // This preserves relative ordering for timestamps within a reasonable range
    const timeDiffSeconds = Math.floor(timeDiffMs / 1000);
    // Scale to fit in 0-MAX_PRIORITY range, ensuring earlier times get lower values
    priority = Math.max(
      0,
      Math.min(MAX_PRIORITY, timeDiffSeconds % (MAX_PRIORITY + 1)),
    );
  }

  // Log scheduling details for debugging
  logger.info(
    `Scheduling start-live job for session ${sessionId}: startTime=${startTime?.toISOString()}, duration=${durationValue} ${durationUnit}, expectedLiveTime=${expectedLiveTime.toISOString()}, delayMs=${delayMs}, delayHours=${(delayMs / (1000 * 60 * 60)).toFixed(2)}, priority=${priority}`,
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
        priority, // Higher priority (lower number) for earlier start_time
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
    // Order by start_time (oldest first) and created_at to ensure first-come-first-served
    // This ensures the first OPENING session gets priority to become LIVE
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
      orderBy: [
        { start_time: 'asc' }, // Oldest start_time first
        { created_at: 'asc' }, // If start_time is same, oldest created_at first
      ],
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

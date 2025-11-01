import { Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { generateUid } from '../../../common/utils/uuid.util';
import { generateSessionName } from '../../../common/utils/session.util';
import { SessionStatus } from '../../../common/types/enums';
import { createStandaloneLogger } from '../../../common/logger/logger.util';

const logger = createStandaloneLogger('SessionWorker');

/**
 * Creates Redis connection with proper error handling and retry logic
 */
function createRedisConnection(): IORedis {
  const redisUrl =
    process.env.REDIS_BULLMQ_URL ||
    process.env.REDIS_URL ||
    'redis://localhost:6379';

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
    retryStrategy: (times) => {
      // Retry with exponential backoff, max 3 retries
      if (times > 3) {
        logger.error(
          `Redis connection failed after ${times} attempts. Giving up.`,
        );
        return null; // Stop retrying
      }
      const delay = Math.min(times * 200, 2000);
      logger.warn(
        `Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
      );
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        // Only reconnect when encountering READONLY error
        return true;
      }
      return false;
    },
    enableReadyCheck: true,
    lazyConnect: false, // Connect immediately
  });

  // Handle connection errors gracefully
  connection.on('error', (err) => {
    logger.error(`Redis connection error: ${err.message}`);
    // Don't crash - let BullMQ handle reconnection
  });

  connection.on('connect', () => {
    logger.info('Redis connection established');
  });

  connection.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return connection;
}

const connection = createRedisConnection();

// Redis key for tracking session creation
const getSessionCreationKey = (sessionProfileId: number, sessionId: number) =>
  `session:creation:pending:${sessionProfileId}:${sessionId}`;

// Prisma client for database operations
const prisma = new PrismaClient();

/**
 * Calculates end time based on duration from profile
 */
function calculateEndTime(
  startTime: Date,
  durationValue: number | null,
  durationUnit: string | null,
): Date | null {
  if (!durationValue || !durationUnit) {
    return null;
  }

  const endTime = new Date(startTime);
  switch (durationUnit.toLowerCase()) {
    case 'hours':
      endTime.setHours(endTime.getHours() + durationValue);
      break;
    case 'minutes':
      endTime.setMinutes(endTime.getMinutes() + durationValue);
      break;
    case 'days':
      endTime.setDate(endTime.getDate() + durationValue);
      break;
    default:
      return null;
  }
  return endTime;
}

/**
 * Creates a new session - extracted logic from SessionService
 */
async function createSession(
  sessionId: number,
  sessionProfileId: number,
): Promise<{ success: boolean; message: string; newSessionId?: number }> {
  // Fetch session profile - must be active and not deleted
  const sessionProfile = await prisma.session_profiles.findFirst({
    where: {
      id: sessionProfileId,
      is_active: true,
      is_deleted: false,
    },
  });

  if (!sessionProfile) {
    throw new Error(
      `Session profile not found, inactive, or deleted: ${sessionProfileId}`,
    );
  }

  // Validate and update existing session if sessionId is provided
  if (sessionId) {
    const existingSession = await prisma.sessions.findUnique({
      where: { id: sessionId },
    });

    if (!existingSession) {
      throw new Error(`Existing session not found: ${sessionId}`);
    }

    // Verify session belongs to the profile
    if (existingSession.session_profile_id !== sessionProfileId) {
      throw new Error(
        `Session ${sessionId} does not belong to profile ${sessionProfileId}`,
      );
    }

    // Update session status from UPCOMING to OPENING if applicable
    if (existingSession.status === SessionStatus.UPCOMING.valueOf()) {
      await prisma.sessions.update({
        where: { id: sessionId },
        data: { status: SessionStatus.OPENING },
      });
    }
  }

  // Check max_sessions limit
  if (
    sessionProfile.max_sessions !== null &&
    sessionProfile.sessions_count >= sessionProfile.max_sessions
  ) {
    throw new Error('Maximum sessions limit reached for this profile');
  }

  // Calculate start and end times
  const startTime = new Date();
  const endTime = calculateEndTime(
    startTime,
    sessionProfile.session_duration_value,
    sessionProfile.session_duration_unit,
  );

  // Generate unique session ID
  const suid = generateUid('ssn_');

  // Create new session
  const sessionNumber = sessionProfile.sessions_count + 1;
  const sessionName = generateSessionName(sessionProfile.title, sessionNumber);

  // Set initial sales count to sales_trigger_count (or 0 if not set)
  const initialSalesCount = sessionProfile.sales_trigger_count || 0;

  const newSession = await prisma.sessions.create({
    data: {
      suid,
      session_profile_id: sessionProfileId,
      name: sessionName,
      start_time: startTime,
      end_time: endTime,
      status: SessionStatus.UPCOMING,
      priority_position: sessionProfile.priority_position,
      is_active: true,
      is_deleted: false,
      current_sales_count: initialSalesCount,
      current_participant_count: 0,
      auto_close_on_full: true,
    },
  });

  // Update session profile sessions_count
  const updatedProfile = await prisma.session_profiles.update({
    where: { id: sessionProfileId },
    data: {
      sessions_count: {
        increment: 1,
      },
    },
  });

  // Check if max_sessions limit reached and disable sales
  if (
    updatedProfile.max_sessions !== null &&
    updatedProfile.sessions_count >= updatedProfile.max_sessions
  ) {
    logger.info(
      `Max sessions limit reached for profile ${sessionProfileId}. Disabling sales for related taxonomy terms.`,
    );

    // Get all taxonomy terms related to this profile
    const sessionTaxonomyTerms = await prisma.session_taxonomy_terms.findMany({
      where: {
        session_profile_id: sessionProfileId,
        is_enabled: true,
      },
      select: {
        term_id: true,
      },
    });

    if (sessionTaxonomyTerms.length > 0) {
      // Disable in database
      await prisma.session_taxonomy_terms.updateMany({
        where: {
          session_profile_id: sessionProfileId,
          is_enabled: true,
        },
        data: {
          is_enabled: false,
        },
      });

      // Set Redis flags for fast checks
      const redisPromises = sessionTaxonomyTerms.map((term) => {
        const redisKey = `taxonomy:${term.term_id}:sales_disabled`;
        return connection.setex(redisKey, 2592000, '1'); // 30 days TTL
      });

      await Promise.all(redisPromises);

      logger.info(
        `Disabled sales for ${sessionTaxonomyTerms.length} taxonomy terms for profile ${sessionProfileId}`,
      );
    }
  }

  return {
    success: true,
    message: `Session created successfully for profile ${sessionProfileId}`,
    newSessionId: newSession.id,
  };
}

export const sessionWorker = new Worker(
  'session-jobs',
  async (job) => {
    if (job.name === 'rotate-session') {
      return Promise.resolve({ rotated: true });
    }

    if (job.name === 'threshold-reached') {
      const jobData = job.data as {
        sessionId: number | string;
        sessionProfileId: number | string;
      };

      // Ensure IDs are numbers (handle both string and number inputs)
      const sessionId =
        typeof jobData.sessionId === 'string'
          ? parseInt(String(jobData.sessionId).replace(/^sess_/, ''), 10)
          : Number(jobData.sessionId);
      const sessionProfileId =
        typeof jobData.sessionProfileId === 'string'
          ? parseInt(String(jobData.sessionProfileId).replace(/^prod_/, ''), 10)
          : Number(jobData.sessionProfileId);

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

        // Delete the sales count key from Redis after successful session creation
        const salesKey = `session:sales:${sessionId}`;
        await connection.del(salesKey);
        logger.info(
          `Session created successfully - new_session_id=${result.newSessionId}, deleted sales key: ${salesKey}`,
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
          {
            sessionId,
            sessionProfileId,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
          `Failed to create session`,
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

    if (job.name === 'sync-sales') {
      try {
        logger.info('Starting sales count sync from Redis to database');

        // Scan Redis for all keys matching session:sales:* pattern
        const redisKeys: string[] = [];
        let cursor = '0';

        do {
          const [nextCursor, keys] = await connection.scan(
            cursor,
            'MATCH',
            'session:sales:*',
            'COUNT',
            100,
          );
          cursor = nextCursor;
          redisKeys.push(...keys);
        } while (cursor !== '0');

        if (redisKeys.length === 0) {
          logger.info('No sales data found in Redis to sync');
          return Promise.resolve({
            synced: true,
            total: 0,
            updated: 0,
            errors: 0,
          });
        }

        logger.info(
          `Found ${redisKeys.length} sessions with sales data in Redis`,
        );

        let updated = 0;
        let errors = 0;

        // Extract session IDs from Redis keys (format: session:sales:{id})
        const sessionDataMap = new Map<number, number>();

        // Read all Redis values in batches
        const batchSize = 50;
        for (let i = 0; i < redisKeys.length; i += batchSize) {
          const batch = redisKeys.slice(i, i + batchSize);
          const values = await Promise.allSettled(
            batch.map((key) => connection.get(key)),
          );

          // Parse session ID and count
          batch.forEach((key, index) => {
            const valueResult = values[index];
            if (valueResult.status === 'fulfilled' && valueResult.value) {
              // Extract session ID from key: session:sales:{id}
              const sessionIdStr = key.replace('session:sales:', '');
              const sessionId = parseInt(sessionIdStr, 10);

              if (!isNaN(sessionId)) {
                const count = parseInt(valueResult.value, 10);
                if (!isNaN(count)) {
                  sessionDataMap.set(sessionId, count);
                }
              }
            }
          });
        }

        if (sessionDataMap.size === 0) {
          logger.info('No valid session data found in Redis');
          return Promise.resolve({
            synced: true,
            total: 0,
            updated: 0,
            errors: 0,
          });
        }

        logger.info(`Processing ${sessionDataMap.size} sessions for sync`);

        // Fetch ONLY sessions that exist in Redis (optimized bulk query)
        const sessionIds = Array.from(sessionDataMap.keys());

        // Fetch sessions from DB (only those with Redis keys)
        const sessions = await prisma.sessions.findMany({
          where: {
            id: { in: sessionIds }, // Only IDs from Redis
          },
          select: {
            id: true,
            current_sales_count: true,
          },
        });

        // Create in-memory map for O(1) lookups
        const sessionMap = new Map<number, (typeof sessions)[0]>();
        sessions.forEach((session) => {
          sessionMap.set(session.id, session);
        });

        // Update database for sessions found in Redis
        for (let i = 0; i < sessionIds.length; i += batchSize) {
          const batchIds = sessionIds.slice(i, i + batchSize);

          const updatePromises = batchIds.map(async (sessionId) => {
            const redisCount = sessionDataMap.get(sessionId) || 0;
            const redisKey = `session:sales:${sessionId}`;

            try {
              // Check if Redis key still exists (might be deleted during session creation)
              const keyExists = await connection.exists(redisKey);
              if (!keyExists) {
                logger.debug(`Redis key ${redisKey} already deleted, skipping`);
                return;
              }

              const session = sessionMap.get(sessionId);

              if (!session) {
                // Session doesn't exist in DB, remove Redis key
                await connection.del(redisKey);
                logger.warn(
                  `Session ${sessionId} not found in DB, removed Redis key`,
                );
                return;
              }

              const currentDbCount = session.current_sales_count || 0;

              // Skip if no sales to sync (already synced)
              if (redisCount === 0) {
                await connection.del(redisKey);
                logger.debug(
                  `Session ${sessionId} already synced (redisCount=0), removed Redis key`,
                );
                return;
              }

              // Simple: Add Redis count to DB count
              const newCount = currentDbCount + redisCount;

              // Update database
              await prisma.sessions.update({
                where: { id: sessionId },
                data: { current_sales_count: newCount },
              });

              // Remove Redis key after successful update
              await connection.del(redisKey);
              updated++;
              logger.debug(
                `Updated session ${sessionId}: ${currentDbCount} + ${redisCount} = ${newCount}`,
              );
            } catch (error) {
              errors++;
              const errorMessage =
                error instanceof Error ? error.message : String(error);

              logger.error(
                {
                  sessionId,
                  error: errorMessage,
                  stack: error instanceof Error ? error.stack : undefined,
                },
                `Failed to update session`,
              );
            }
          });

          await Promise.allSettled(updatePromises);

          // Small delay between batches
          if (i + batchSize < sessionIds.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        logger.info(
          `Sales count sync completed - total=${sessionDataMap.size}, updated=${updated}, errors=${errors}`,
        );

        return Promise.resolve({
          synced: true,
          total: sessionDataMap.size,
          updated,
          errors,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        logger.error(
          {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Sales count sync failed',
        );
        throw error;
      }
    }

    return Promise.resolve({ ok: true });
  },
  { connection },
);

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

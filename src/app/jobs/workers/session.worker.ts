import { Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { generateUid } from '../../../common/utils/uuid.util';
import { generateSessionName } from '../../../common/utils/session.util';
import { SessionStatus } from '../../../common/types/enums';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('SessionWorker');

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
      // Retry indefinitely with exponential backoff
      // This ensures the connection keeps trying even if Redis is temporarily unavailable
      const delay = Math.min(times * 200, 5000); // Max 5 seconds between retries
      logger.warn(
        `Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
      );
      return delay; // Keep retrying - never return null
    },
    reconnectOnError: (err) => {
      // Reconnect on any connection-related errors, not just READONLY
      const reconnectErrors = [
        'READONLY',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE',
        'Connection lost',
        'Connection closed',
      ];

      const shouldReconnect = reconnectErrors.some((errorType) =>
        err.message.includes(errorType),
      );

      if (shouldReconnect) {
        logger.warn(
          `Redis error detected (${err.message}), attempting reconnection...`,
        );
        return true;
      }

      // For other errors, let IORedis handle them
      return false;
    },
    enableReadyCheck: true,
    lazyConnect: false, // Connect immediately
    enableOfflineQueue: true, // Queue commands when disconnected
    connectTimeout: 10000, // 10 second connection timeout
    // Keep connection alive
    keepAlive: 30000, // Send keepalive every 30 seconds
  });

  // Handle connection errors gracefully
  connection.on('error', (err) => {
    logger.error(`Redis connection error: ${err.message}`);
    // Don't crash - IORedis will handle reconnection automatically
  });

  connection.on('connect', () => {
    logger.info('Redis connection established');
  });

  connection.on('ready', () => {
    logger.info('Redis connection ready and operational');
  });

  connection.on('close', () => {
    logger.warn('Redis connection closed - will attempt to reconnect');
  });

  connection.on('reconnecting', (delay: number) => {
    logger.warn(`Redis reconnecting in ${delay}ms...`);
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

  // New sessions always start with 0 sales count
  // sales_trigger_count is the threshold/limit per session, not an initial count
  const initialSalesCount = 0;

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
  await prisma.session_profiles.update({
    where: { id: sessionProfileId },
    data: {
      sessions_count: {
        increment: 1,
      },
    },
  });

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
                // Session doesn't exist in DB - keep the Redis key, might be a timing issue
                // Don't delete here - let session end handler clean it up
                logger.warn(
                  `Session ${sessionId} not found in DB, but keeping Redis key`,
                );
                return;
              }

              const currentDbCount = session.current_sales_count || 0;

              // Redis contains the TOTAL/cumulative count for the session
              // DO NOT delete the Redis key - it must stay persistent for the session
              // Only sync if Redis count is higher than DB (new sales to sync)
              if (redisCount <= currentDbCount) {
                logger.debug(
                  `Session ${sessionId} already in sync (Redis ${redisCount} <= DB ${currentDbCount}), skipping`,
                );
                return;
              }

              // Redis has the cumulative total, so we just use it directly
              const newCount = redisCount;

              try {
                // Update database
                await prisma.sessions.update({
                  where: { id: sessionId },
                  data: { current_sales_count: newCount },
                });

                updated++;
                logger.debug(
                  `Updated session ${sessionId}: DB ${currentDbCount} → ${newCount} (Redis total)`,
                );
              } catch (updateError) {
                // DB update failed - don't lose the count, just log error
                errors++;
                const errorMessage =
                  updateError instanceof Error
                    ? updateError.message
                    : String(updateError);
                logger.error(
                  `Failed to update session ${sessionId}: ${errorMessage}`,
                  updateError instanceof Error ? updateError.stack : undefined,
                );
              }
            } catch (error) {
              errors++;
              const errorMessage =
                error instanceof Error ? error.message : String(error);

              logger.error(
                `Failed to update session ${sessionId}: ${errorMessage}`,
                error instanceof Error ? error.stack : undefined,
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
          `Sales count sync failed: ${errorMessage}`,
          error instanceof Error ? error.stack : undefined,
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

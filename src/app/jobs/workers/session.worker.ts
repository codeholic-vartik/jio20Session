import { Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { generateUid } from '../../../common/utils/uuid.util';
import { generateSessionName } from '../../../common/utils/session.util';
import { SessionStatus } from '../../../common/types/enums';

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
        console.error(
          `[WORKER] Redis connection failed after ${times} attempts. Giving up.`,
        );
        return null; // Stop retrying
      }
      const delay = Math.min(times * 200, 2000);
      console.warn(
        `[WORKER] Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
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
    console.error(`[WORKER] Redis connection error: ${err.message}`);
    // Don't crash - let BullMQ handle reconnection
  });

  connection.on('connect', () => {
    console.log('[WORKER] Redis connection established');
  });

  connection.on('close', () => {
    console.warn('[WORKER] Redis connection closed');
  });

  return connection;
}

const connection = createRedisConnection();

// Redis key for tracking session creation
const getSessionCreationKey = (sessionProfileId: number, sessionId: number) =>
  `session:creation:pending:${sessionProfileId}:${sessionId}`;

// Get Redis sales key TTL from environment (default: 30 days in seconds)
const getSalesKeyTTL = (): number => {
  const ttlDays = parseInt(process.env.REDIS_SALES_KEY_TTL_DAYS || '30', 10);
  // Convert days to seconds (30 days = 30 * 24 * 60 * 60 = 2592000 seconds)
  return ttlDays * 24 * 60 * 60;
};

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
      current_sales_count: 0,
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

        console.log(
          `WORKER: Processing threshold reached - session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
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
        console.log(
          `WORKER: Session created successfully - new_session_id=${result.newSessionId}, deleted sales key: ${salesKey}`,
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

        console.error(
          `WORKER: Failed to create session - session_id=${sessionId}, session_profile_id=${sessionProfileId}, error=${errorMessage}`,
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
        console.log('WORKER: Starting sales count sync from Redis to database');

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
          console.log('WORKER: No sales data found in Redis to sync');
          return Promise.resolve({
            synced: true,
            total: 0,
            updated: 0,
            errors: 0,
          });
        }

        console.log(
          `WORKER: Found ${redisKeys.length} sessions with sales data in Redis`,
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
          console.log('WORKER: No valid session data found in Redis');
          return Promise.resolve({
            synced: true,
            total: 0,
            updated: 0,
            errors: 0,
          });
        }

        console.log(
          `WORKER: Processing ${sessionDataMap.size} sessions for sync`,
        );

        // Update database for sessions found in Redis
        const sessionIds = Array.from(sessionDataMap.keys());
        for (let i = 0; i < sessionIds.length; i += batchSize) {
          const batchIds = sessionIds.slice(i, i + batchSize);

          // Update each session in the batch
          const updatePromises = batchIds.map(async (sessionId) => {
            const redisCount = sessionDataMap.get(sessionId) || 0;
            const redisKey = `session:sales:${sessionId}`;

            try {
              // Get current sales count from database
              const session = await prisma.sessions.findUnique({
                where: { id: sessionId },
                select: { current_sales_count: true },
              });

              if (!session) {
                // Session doesn't exist in DB, set expiration on Redis key
                const ttl = getSalesKeyTTL();
                await connection.expire(redisKey, ttl);
                console.log(
                  `WORKER: Session ${sessionId} not found in DB, set ${ttl / 86400}-day TTL on Redis key`,
                );
                return;
              }

              // Add Redis count to current DB count
              const currentDbCount = session.current_sales_count || 0;
              const newCount = currentDbCount + redisCount;

              // Update database with the incremented count
              await prisma.sessions.update({
                where: { id: sessionId },
                data: { current_sales_count: newCount },
              });

              // Set expiration time from environment (default: 30 days)
              const ttl = getSalesKeyTTL();
              await connection.expire(redisKey, ttl);
              updated++;
              console.log(
                `WORKER: Updated session ${sessionId}: ${currentDbCount} + ${redisCount} = ${newCount}, set ${ttl / 86400}-day TTL on Redis key`,
              );
            } catch (error) {
              errors++;
              const errorMessage =
                error instanceof Error ? error.message : String(error);

              console.error(
                `WORKER: Failed to update session ${sessionId}: ${errorMessage}`,
              );
            }
          });

          await Promise.allSettled(updatePromises);

          // Small delay between batches
          if (i + batchSize < sessionIds.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        console.log(
          `WORKER: Sales count sync completed - total=${sessionDataMap.size}, updated=${updated}, errors=${errors}`,
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
        console.error(`WORKER: Sales count sync failed: ${errorMessage}`);
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

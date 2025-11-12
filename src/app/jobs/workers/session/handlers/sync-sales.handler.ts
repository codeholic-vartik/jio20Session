/**
 * @fileoverview Sales sync job handler
 * @description Syncs sales counts from Redis to database periodically
 */

import { Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { SessionStatus } from '../../../../../common/types/enums/session-status.enum';
import { getSyncSalesBatchSize } from '../config/sync-sales.config';

const logger: StandaloneLogger = createStandaloneLogger('SyncSalesHandler');
const prisma = new PrismaClient();

/** Batch size for processing Redis keys and database updates */
const BATCH_SIZE = getSyncSalesBatchSize();

/**
 * Handles sync-sales job
 *
 * @description
 * Syncs cumulative sales counts from Redis to the database. This job:
 * 1. Scans Redis for all `session:sales:*` keys
 * 2. Fetches corresponding sessions from database
 * 3. Updates `current_sales_count` if Redis value is higher
 * 4. Processes in batches for performance
 * 5. Only syncs if Redis count > DB count (avoids overwriting with stale data)
 * 6. Cleans up Redis keys for sessions missing from DB or already completed
 *
 * @important
 * - Leaves Redis keys for active sessions; removes stale/completed session keys
 * - Only updates if Redis count is higher than DB count
 * - Handles missing sessions gracefully by cleaning up Redis
 * - Processes in batches of 50 for performance
 *
 * @param {Job} job - BullMQ job instance
 * @param {IORedis} connection - Redis connection for reading sales data
 * @returns {Promise<Object>} Result object with sync statistics
 * @returns {boolean} returns.synced - Whether sync completed
 * @returns {number} returns.total - Total sessions found in Redis
 * @returns {number} returns.updated - Number of sessions updated in DB
 * @returns {number} returns.errors - Number of errors encountered
 *
 * @example
 * ```typescript
 * // Job is automatically routed here when job.name === 'sync-sales'
 * const result = await handleSyncSales(job, connection);
 * // Returns: { synced: true, total: 10, updated: 8, errors: 0 }
 * ```
 *
 * @redis
 * Reads from Redis keys: `session:sales:{sessionId}`
 * - These keys store cumulative sales count per session
 * - Keys are NOT deleted by this handler
 * - Keys should be managed by session lifecycle handlers
 */
export async function handleSyncSales(
  job: Job,
  connection: IORedis,
): Promise<{
  synced: boolean;
  total: number;
  updated: number;
  errors: number;
}> {
  try {
    // Log which Redis database we're using for debugging
    const dbIndex =
      connection.options?.db !== undefined ? connection.options.db : 'unknown';
    logger.info(
      `Starting sales count sync from Redis to database (Redis DB index: ${dbIndex})`,
    );

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
      logger.warn(
        `No sales data found in Redis to sync (Redis DB index: ${dbIndex}) - checking if keys exist with different pattern`,
      );
      // Debug: Try to check if any session:sales keys exist at all
      const testKey = await connection.keys('session:sales:*');
      if (testKey.length > 0) {
        logger.warn(
          `Found ${testKey.length} keys with KEYS command but SCAN found 0 - possible database mismatch. Keys found: ${testKey.slice(0, 5).join(', ')}${testKey.length > 5 ? '...' : ''}`,
        );
      } else {
        logger.warn(
          `No session:sales:* keys found in Redis DB index ${dbIndex} - sales data may be stored in a different Redis database`,
        );
      }
      return Promise.resolve({
        synced: true,
        total: 0,
        updated: 0,
        errors: 0,
      });
    }

    logger.info(
      `Found ${redisKeys.length} sessions with sales data in Redis: ${redisKeys.slice(0, 10).join(', ')}${redisKeys.length > 10 ? '...' : ''}`,
    );

    let updated = 0;
    let errors = 0;

    // Extract session IDs from Redis keys (format: session:sales:{id})
    const sessionDataMap = new Map<number, number>();

    // Read all Redis values in batches using mget for better performance
    // mget is faster than multiple individual get() calls
    for (let i = 0; i < redisKeys.length; i += BATCH_SIZE) {
      const batch = redisKeys.slice(i, i + BATCH_SIZE);

      // Use mget for batch reads (faster than Promise.all with individual gets)
      const values = await connection.mget(...batch);

      // Parse session ID and count
      batch.forEach((key, index) => {
        const value = values[index];
        if (value) {
          // Extract session ID from key: session:sales:{id}
          const sessionIdStr = key.replace('session:sales:', '');
          const sessionId = parseInt(sessionIdStr, 10);

          if (!isNaN(sessionId)) {
            const count = parseInt(value, 10);
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

    logger.info(
      `Processing ${sessionDataMap.size} sessions for sync. Session IDs: ${Array.from(sessionDataMap.keys()).slice(0, 10).join(', ')}${sessionDataMap.size > 10 ? '...' : ''}`,
    );

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
        status: true,
      },
    });

    // Create in-memory map for O(1) lookups
    const sessionMap = new Map<number, (typeof sessions)[0]>();
    sessions.forEach((session) => {
      sessionMap.set(session.id, session);
    });

    // Update database for sessions found in Redis
    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      const batchIds = sessionIds.slice(i, i + BATCH_SIZE);

      const updatePromises = batchIds.map(async (sessionId) => {
        const redisKey = `session:sales:${sessionId}`;

        const removeRedisKey = async (reason: string) => {
          try {
            await connection.del(redisKey);
            logger.warn(`Removed Redis key ${redisKey} - ${reason}`);
          } catch (deleteError) {
            errors++;
            const deleteMessage =
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError);
            logger.error(
              `Failed to delete Redis key ${redisKey}: ${deleteMessage}`,
              deleteError instanceof Error ? deleteError.stack : undefined,
            );
          }
        };

        try {
          // Re-read Redis value right before update to ensure we have the latest value
          // This prevents using stale values from the initial batch read
          // Using get() directly is faster than exists() + get() (one less round trip)
          const latestRedisValue = await connection.get(redisKey);
          if (!latestRedisValue) {
            logger.warn(
              `Redis key ${redisKey} has no value or was deleted between scan and update - this may indicate database mismatch`,
            );
            return;
          }

          const latestRedisCount = parseInt(latestRedisValue, 10);
          if (isNaN(latestRedisCount)) {
            logger.warn(
              `Redis key ${redisKey} has invalid value: ${latestRedisValue}, skipping`,
            );
            return;
          }

          const session = sessionMap.get(sessionId);

          if (!session) {
            await removeRedisKey(`session ${sessionId} not found in DB`);
            return;
          }

          const sessionStatus = session.status as SessionStatus | null;
          if (sessionStatus === SessionStatus.COMPLETED) {
            await removeRedisKey(
              `session ${sessionId} is ${SessionStatus.COMPLETED} in DB`,
            );
            return;
          }

          // Handle null DB values properly - null means 0, but we should sync if Redis has a value
          const currentDbCount =
            session.current_sales_count !== null &&
            session.current_sales_count !== undefined
              ? session.current_sales_count
              : 0;

          // Redis contains the TOTAL/cumulative count for the session
          // DO NOT delete the Redis key - it must stay persistent for the session
          // Only sync if Redis count is higher than DB (new sales to sync)
          if (latestRedisCount <= currentDbCount) {
            logger.debug(
              `Session ${sessionId} already in sync (Redis ${latestRedisCount} <= DB ${currentDbCount}), skipping`,
            );
            return;
          }

          // Redis has the cumulative total, so we just use it directly
          const newCount = latestRedisCount;

          try {
            // Update database
            await prisma.sessions.update({
              where: { id: sessionId },
              data: { current_sales_count: newCount },
            });

            updated++;
            logger.info(
              `Updated session ${sessionId}: DB ${currentDbCount} → ${newCount} (Redis total, diff: +${newCount - currentDbCount})`,
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

      // No delay needed - Promise.allSettled already handles concurrency
      // Database can handle the load, and we want fast sync
    }

    logger.info(
      `Sales count sync completed - total=${sessionDataMap.size}, updated=${updated}, errors=${errors}, skipped=${sessionDataMap.size - updated - errors}`,
    );

    // Log summary of what was found vs updated for debugging
    if (sessionDataMap.size > 0 && updated === 0) {
      logger.warn(
        `WARNING: Found ${sessionDataMap.size} sessions in Redis but updated 0. This may indicate: 1) All sessions already in sync, 2) Redis values <= DB values, or 3) Database connection issue. Check logs above for details.`,
      );
    }

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

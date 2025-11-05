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

const logger: StandaloneLogger = createStandaloneLogger('SyncSalesHandler');
const prisma = new PrismaClient();

/** Batch size for processing Redis keys and database updates */
const BATCH_SIZE = 50;

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
 *
 * @important
 * - Does NOT delete Redis keys (they persist for session lifetime)
 * - Only updates if Redis count is higher than DB count
 * - Handles missing sessions gracefully (keeps Redis key)
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

    logger.info(`Found ${redisKeys.length} sessions with sales data in Redis`);

    let updated = 0;
    let errors = 0;

    // Extract session IDs from Redis keys (format: session:sales:{id})
    const sessionDataMap = new Map<number, number>();

    // Read all Redis values in batches
    for (let i = 0; i < redisKeys.length; i += BATCH_SIZE) {
      const batch = redisKeys.slice(i, i + BATCH_SIZE);
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
    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      const batchIds = sessionIds.slice(i, i + BATCH_SIZE);

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
      if (i + BATCH_SIZE < sessionIds.length) {
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

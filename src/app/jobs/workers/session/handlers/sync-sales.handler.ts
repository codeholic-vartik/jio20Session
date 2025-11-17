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
    // Use larger COUNT for better performance with 10k+ keys
    const redisKeys: string[] = [];
    let cursor = '0';
    let scanIterations = 0;
    const SCAN_COUNT = 1000; // Larger count for 10k+ keys

    do {
      const [nextCursor, keys] = await connection.scan(
        cursor,
        'MATCH',
        'session:sales:*',
        'COUNT',
        SCAN_COUNT,
      );
      cursor = nextCursor;
      redisKeys.push(...keys);
      scanIterations++;

      // Log progress for large datasets
      if (redisKeys.length % 5000 === 0 && redisKeys.length > 0) {
        logger.info(
          `Scanning Redis keys... found ${redisKeys.length} keys so far (scan iterations: ${scanIterations})`,
        );
      }
    } while (cursor !== '0');

    if (scanIterations > 1) {
      logger.info(
        `Completed Redis scan: found ${redisKeys.length} keys in ${scanIterations} iterations`,
      );
    }

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

    // Log summary for large datasets
    if (redisKeys.length > 100) {
      logger.info(
        `Found ${redisKeys.length} sessions with sales data in Redis (showing first 10): ${redisKeys.slice(0, 10).join(', ')}...`,
      );
    } else {
      logger.info(
        `Found ${redisKeys.length} sessions with sales data in Redis: ${redisKeys.slice(0, 10).join(', ')}${redisKeys.length > 10 ? '...' : ''}`,
      );
    }

    let updated = 0;
    let errors = 0;

    // Extract session IDs from Redis keys (format: session:sales:{id})
    const sessionDataMap = new Map<number, number>();

    // Read all Redis values in batches using mget for better performance
    // mget is faster than multiple individual get() calls
    // For 10k+ keys, use larger batches for Redis reads (but smaller for DB updates)
    const REDIS_READ_BATCH_SIZE = Math.min(BATCH_SIZE * 2, 200); // Larger batches for Redis reads

    logger.info(
      `Reading ${redisKeys.length} Redis values in batches of ${REDIS_READ_BATCH_SIZE}...`,
    );

    for (let i = 0; i < redisKeys.length; i += REDIS_READ_BATCH_SIZE) {
      const batch = redisKeys.slice(i, i + REDIS_READ_BATCH_SIZE);

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

      // Log progress for large datasets
      if (redisKeys.length > 1000 && (i + REDIS_READ_BATCH_SIZE) % 5000 === 0) {
        logger.info(
          `Reading Redis values... processed ${Math.min(i + REDIS_READ_BATCH_SIZE, redisKeys.length)}/${redisKeys.length} keys`,
        );
      }
    }

    logger.info(
      `Completed reading Redis values: ${sessionDataMap.size} valid session counts extracted`,
    );

    if (sessionDataMap.size === 0) {
      logger.info('No valid session data found in Redis');
      return Promise.resolve({
        synced: true,
        total: 0,
        updated: 0,
        errors: 0,
      });
    }

    // Fetch ONLY sessions that exist in Redis (optimized bulk query)
    const sessionIds = Array.from(sessionDataMap.keys());

    if (sessionIds.length > 100) {
      logger.info(
        `Processing ${sessionDataMap.size} sessions for sync (showing first 10 IDs): ${sessionIds.slice(0, 10).join(', ')}...`,
      );
    } else {
      logger.info(
        `Processing ${sessionDataMap.size} sessions for sync. Session IDs: ${sessionIds.slice(0, 10).join(', ')}${sessionIds.length > 10 ? '...' : ''}`,
      );
    }

    // For large datasets (10k+), fetch sessions in chunks to avoid query size limits
    // PostgreSQL has a limit on IN clause size (typically 1000-10000 items)
    const DB_FETCH_BATCH_SIZE = 5000; // Safe batch size for PostgreSQL IN clause
    const sessions: Array<{
      id: number;
      current_sales_count: number | null;
      status: string;
    }> = [];

    if (sessionIds.length > DB_FETCH_BATCH_SIZE) {
      logger.info(
        `Fetching ${sessionIds.length} sessions from DB in batches of ${DB_FETCH_BATCH_SIZE}...`,
      );

      for (let i = 0; i < sessionIds.length; i += DB_FETCH_BATCH_SIZE) {
        const batchIds = sessionIds.slice(i, i + DB_FETCH_BATCH_SIZE);
        const batchSessions = await prisma.sessions.findMany({
          where: {
            id: { in: batchIds },
          },
          select: {
            id: true,
            current_sales_count: true,
            status: true,
          },
        });
        sessions.push(...batchSessions);

        // Log progress for large datasets
        if ((i + DB_FETCH_BATCH_SIZE) % 10000 === 0) {
          logger.info(
            `Fetched ${Math.min(i + DB_FETCH_BATCH_SIZE, sessionIds.length)}/${sessionIds.length} sessions from DB`,
          );
        }
      }

      logger.info(
        `Completed fetching sessions from DB: ${sessions.length} sessions found`,
      );
    } else {
      // Single query for smaller datasets
      const fetchedSessions = await prisma.sessions.findMany({
        where: {
          id: { in: sessionIds },
        },
        select: {
          id: true,
          current_sales_count: true,
          status: true,
        },
      });
      sessions.push(...fetchedSessions);
    }

    // Create in-memory map for O(1) lookups
    const sessionMap = new Map<number, (typeof sessions)[0]>();
    sessions.forEach((session) => {
      sessionMap.set(session.id, session);
    });

    // Track skipped sessions separately (sessions already in sync)
    let skippedCount = 0;

    // For 10k+ sessions, log progress periodically
    const shouldLogProgress = sessionIds.length > 1000;
    const progressLogInterval = 1000; // Log every 1000 sessions

    logger.info(
      `Starting database updates for ${sessionIds.length} sessions in batches of ${BATCH_SIZE}...`,
    );

    // Prepare sessions that need syncing (filter out already synced, missing, or completed)
    const sessionsToSync: Array<{
      sessionId: number;
      redisCount: number;
      dbCount: number;
      redisKey: string;
    }> = [];

    // First pass: identify which sessions need syncing
    for (const sessionId of sessionIds) {
      const redisCount = sessionDataMap.get(sessionId);
      if (redisCount === undefined) {
        skippedCount++;
        continue;
      }

      const session = sessionMap.get(sessionId);
      if (!session) {
        // Session not found in DB - clean up Redis key
        try {
          await connection.del(`session:sales:${sessionId}`);
          logger.debug(`Removed Redis key for missing session ${sessionId}`);
        } catch (deleteError) {
          logger.warn(
            `Failed to delete Redis key for missing session ${sessionId}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
          );
        }
        skippedCount++;
        continue;
      }

      const sessionStatus = session.status as SessionStatus | null;
      if (sessionStatus === SessionStatus.COMPLETED) {
        // Completed session - clean up Redis key
        try {
          await connection.del(`session:sales:${sessionId}`);
          logger.debug(`Removed Redis key for completed session ${sessionId}`);
        } catch (deleteError) {
          logger.warn(
            `Failed to delete Redis key for completed session ${sessionId}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
          );
        }
        skippedCount++;
        continue;
      }

      // Handle null DB values properly - null means 0
      const dbCount =
        session.current_sales_count !== null &&
        session.current_sales_count !== undefined
          ? Number(session.current_sales_count)
          : 0;

      const redisCountNum = Number(redisCount);
      const dbCountNum = Number(dbCount);

      // CHECK: If already synced, skip update
      if (redisCountNum === dbCountNum) {
        skippedCount++;
        continue;
      }

      // Add to sync list
      sessionsToSync.push({
        sessionId,
        redisCount: redisCountNum,
        dbCount: dbCountNum,
        redisKey: `session:sales:${sessionId}`,
      });
    }

    logger.info(
      `Prepared ${sessionsToSync.length} sessions for sync (${skippedCount} already synced/skipped)`,
    );

    // Update database in batches using bulk SQL for better performance
    for (let i = 0; i < sessionsToSync.length; i += BATCH_SIZE) {
      const batch = sessionsToSync.slice(i, i + BATCH_SIZE);

      // Log progress for large datasets
      if (shouldLogProgress && i > 0 && i % progressLogInterval === 0) {
        logger.info(
          `Sync progress: processed ${i}/${sessionsToSync.length} sessions (${Math.round((i / sessionsToSync.length) * 100)}%)`,
        );
      }

      try {
        // Use batch transaction for better performance
        // Update all sessions in the batch within a single transaction
        const transactionStartTime = Date.now();
        logger.debug(
          `Starting transaction for batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batch.length} sessions`,
        );

        const batchUpdated = await prisma.$transaction(
          async (tx) => {
            let batchUpdatedCount = 0;

            // Update each session in the batch
            for (const item of batch) {
              try {
                // Re-check if still needs sync (might have been updated by another process)
                const currentSession = await tx.sessions.findUnique({
                  where: { id: item.sessionId },
                  select: { current_sales_count: true },
                });

                if (!currentSession) {
                  // Session not found - this shouldn't happen but handle gracefully
                  logger.warn(
                    `Session ${item.sessionId} not found in DB during batch update`,
                  );
                  continue;
                }

                const currentDbValue =
                  currentSession.current_sales_count !== null &&
                  currentSession.current_sales_count !== undefined
                    ? Number(currentSession.current_sales_count)
                    : 0;

                // Only update if still needs syncing (Redis is source of truth)
                if (currentDbValue !== item.redisCount) {
                  await tx.sessions.update({
                    where: { id: item.sessionId },
                    data: {
                      current_sales_count: item.redisCount,
                      updated_at: new Date(),
                    },
                  });
                  batchUpdatedCount++;
                } else {
                  skippedCount++;
                }
              } catch (itemError) {
                // Log error but continue with other items in batch
                // We'll retry failed items in fallback
                logger.warn(
                  `Failed to update session ${item.sessionId} in batch transaction: ${itemError instanceof Error ? itemError.message : String(itemError)}`,
                );
                // Throw to mark this item as failed (will be caught and retried)
                throw itemError;
              }
            }

            return batchUpdatedCount;
          },
          {
            maxWait: 10000, // 10 seconds max wait for transaction to start
            timeout: 60000, // Increased from 30s to 60s to prevent premature timeouts under load
          },
        );

        const transactionDuration = Date.now() - transactionStartTime;
        if (transactionDuration > 5000) {
          logger.warn(
            `Transaction for batch ${Math.floor(i / BATCH_SIZE) + 1} took ${transactionDuration}ms (longer than 5s)`,
          );
        } else {
          logger.debug(
            `Transaction for batch ${Math.floor(i / BATCH_SIZE) + 1} completed in ${transactionDuration}ms`,
          );
        }

        const rowsUpdated = batchUpdated;

        if (rowsUpdated > 0) {
          updated += rowsUpdated;
          logger.debug(
            `Bulk updated ${rowsUpdated} sessions in batch ${Math.floor(i / BATCH_SIZE) + 1}`,
          );

          // Log warnings for sessions where Redis < DB (unusual case)
          for (const item of batch) {
            if (item.redisCount < item.dbCount) {
              logger.warn(
                `Session ${item.sessionId} Redis count (${item.redisCount}) < DB count (${item.dbCount}). Updated DB to match Redis (Redis is source of truth).`,
              );
            }
          }
        } else {
          // No rows updated - might be race condition, verify individually
          logger.debug(
            `Bulk update returned 0 rows for batch ${Math.floor(i / BATCH_SIZE) + 1}, verifying individually...`,
          );

          // Fallback: verify and update individually if bulk update didn't work
          for (const item of batch) {
            try {
              const currentSession = await prisma.sessions.findUnique({
                where: { id: item.sessionId },
                select: { current_sales_count: true },
              });

              const currentDbValue =
                currentSession?.current_sales_count !== null &&
                currentSession?.current_sales_count !== undefined
                  ? Number(currentSession.current_sales_count)
                  : 0;

              if (currentDbValue !== item.redisCount) {
                await prisma.sessions.update({
                  where: { id: item.sessionId },
                  data: {
                    current_sales_count: item.redisCount,
                    updated_at: new Date(),
                  },
                });
                updated++;
                logger.debug(
                  `Updated session ${item.sessionId}: DB ${currentDbValue} → ${item.redisCount}`,
                );
              } else {
                skippedCount++;
              }
            } catch (individualError) {
              errors++;
              logger.error(
                `Failed to update session ${item.sessionId}: ${individualError instanceof Error ? individualError.message : String(individualError)}`,
              );
            }
          }
        }
      } catch (batchError) {
        // Batch transaction failed - fallback to individual updates to ensure no data loss
        const errorMessage =
          batchError instanceof Error ? batchError.message : String(batchError);
        const errorStack =
          batchError instanceof Error ? batchError.stack : undefined;

        // Check if this is a timeout error
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('timed out') ||
          errorMessage.includes('Transaction API error')
        ) {
          logger.error(
            `⚠️ TRANSACTION TIMEOUT: Batch ${Math.floor(i / BATCH_SIZE) + 1} timed out after 60s. This indicates database is overloaded or lock contention. Error: ${errorMessage}`,
            errorStack,
          );
        } else if (
          errorMessage.includes('deadlock') ||
          errorMessage.includes('lock')
        ) {
          logger.error(
            `⚠️ DATABASE LOCK/DEADLOCK: Batch ${Math.floor(i / BATCH_SIZE) + 1} encountered lock contention. Error: ${errorMessage}`,
            errorStack,
          );
        } else {
          logger.warn(
            `Batch transaction failed for batch ${Math.floor(i / BATCH_SIZE) + 1}, falling back to individual updates to ensure no data loss: ${errorMessage}`,
            errorStack,
          );
        }

        // Retry each item individually to ensure all Redis values are synced
        for (const item of batch) {
          try {
            // Re-verify Redis value is still valid before updating
            const redisValue = await connection.get(item.redisKey);
            if (!redisValue) {
              logger.warn(
                `Redis key ${item.redisKey} no longer exists, skipping session ${item.sessionId}`,
              );
              skippedCount++;
              continue;
            }

            const redisCount = parseInt(redisValue.trim(), 10);
            if (isNaN(redisCount) || redisCount < 0) {
              logger.warn(
                `Invalid Redis value for session ${item.sessionId}: ${redisValue}, skipping`,
              );
              skippedCount++;
              continue;
            }

            // Update with latest Redis value
            await prisma.sessions.update({
              where: { id: item.sessionId },
              data: {
                current_sales_count: redisCount,
                updated_at: new Date(),
              },
            });
            updated++;
            logger.debug(
              `Successfully synced session ${item.sessionId} via fallback: ${item.redisCount} → ${redisCount}`,
            );
          } catch (individualError) {
            errors++;
            logger.error(
              `Failed to update session ${item.sessionId} in fallback: ${individualError instanceof Error ? individualError.message : String(individualError)}`,
              individualError instanceof Error
                ? individualError.stack
                : undefined,
            );
          }
        }
      }

      // Small delay between batches for large datasets to avoid overwhelming the database
      if (sessionIds.length > 10000 && i + BATCH_SIZE < sessionsToSync.length) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // Calculate final skipped count (sessions that were already in sync)
    const totalSkipped = skippedCount;

    // VERIFICATION: Verify all Redis values are properly synced to DB
    // This ensures no data loss - check a sample of synced sessions
    let verificationErrors = 0;
    const verificationSampleSize = Math.min(100, sessionsToSync.length);
    if (sessionsToSync.length > 0 && updated > 0) {
      logger.info(
        `Verifying sync accuracy: checking ${verificationSampleSize} random sessions...`,
      );

      const sampleSessions = sessionsToSync
        .sort(() => Math.random() - 0.5)
        .slice(0, verificationSampleSize);

      for (const item of sampleSessions) {
        try {
          // Re-read from Redis to get latest value
          const redisValue = await connection.get(item.redisKey);
          const dbSession = await prisma.sessions.findUnique({
            where: { id: item.sessionId },
            select: { current_sales_count: true },
          });

          if (redisValue && dbSession) {
            const redisCount = parseInt(redisValue.trim(), 10);
            const dbCount =
              dbSession.current_sales_count !== null &&
              dbSession.current_sales_count !== undefined
                ? Number(dbSession.current_sales_count)
                : 0;

            if (redisCount !== dbCount) {
              verificationErrors++;
              logger.warn(
                `Verification failed for session ${item.sessionId}: Redis=${redisCount}, DB=${dbCount} - attempting to fix...`,
              );

              // Attempt to fix the mismatch
              try {
                await prisma.sessions.update({
                  where: { id: item.sessionId },
                  data: {
                    current_sales_count: redisCount,
                    updated_at: new Date(),
                  },
                });
                updated++;
                logger.info(
                  `Fixed sync mismatch for session ${item.sessionId}: DB updated to ${redisCount}`,
                );
              } catch (fixError) {
                errors++;
                logger.error(
                  `Failed to fix sync mismatch for session ${item.sessionId}: ${fixError instanceof Error ? fixError.message : String(fixError)}`,
                );
              }
            }
          }
        } catch (verifyError) {
          logger.warn(
            `Verification check failed for session ${item.sessionId}: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`,
          );
        }
      }

      if (verificationErrors === 0) {
        logger.info(
          `✓ Verification passed: All ${verificationSampleSize} sampled sessions are properly synced`,
        );
      } else {
        logger.warn(
          `⚠ Verification found ${verificationErrors} mismatches out of ${verificationSampleSize} sampled sessions`,
        );
      }
    }

    // Log detailed summary
    const syncRate =
      sessionDataMap.size > 0 ? (updated / sessionDataMap.size) * 100 : 0;
    const successRate =
      sessionDataMap.size > 0
        ? ((updated + totalSkipped) / sessionDataMap.size) * 100
        : 0;

    logger.info(
      `Sales count sync completed - total=${sessionDataMap.size}, updated=${updated} (${syncRate.toFixed(1)}%), skipped=${totalSkipped} (already synced), errors=${errors}, success_rate=${successRate.toFixed(1)}%`,
    );

    // Log performance summary for large datasets
    if (sessionDataMap.size > 1000) {
      logger.info(
        `Large dataset sync summary: ${sessionDataMap.size} sessions processed, ${updated} updated, ${totalSkipped} skipped, ${errors} errors`,
      );
    }

    // Ensure no data loss: if we have errors, log critical warning
    if (errors > 0) {
      logger.error(
        `⚠ CRITICAL: ${errors} sessions failed to sync. Some Redis sales counts may not be synced to database. Please check logs above and retry if needed.`,
      );
    } else if (sessionDataMap.size > 0) {
      logger.info(
        `✓ SUCCESS: All ${sessionDataMap.size} Redis sales counts have been properly synced to database (${updated} updated, ${totalSkipped} already synced)`,
      );
    }

    // Final completion log to verify handler finished
    logger.info(
      `🏁 Sync-sales handler completed successfully - returning result: { synced: true, total: ${sessionDataMap.size}, updated: ${updated}, errors: ${errors} }`,
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
      `❌ Sales count sync FAILED with exception: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error;
  }
}

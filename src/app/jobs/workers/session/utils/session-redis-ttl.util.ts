/**
 * @fileoverview Utility functions for setting TTL on session Redis keys
 * @description Sets TTL on session-related Redis keys when sessions are completed
 */

import IORedis from 'ioredis';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { createSalesSyncRedisConnection } from '../config/redis.config';

const logger: StandaloneLogger = createStandaloneLogger('SessionRedisTTL');

/**
 * Gets the TTL in seconds from environment variable
 * @returns TTL in seconds (default: 30 days = 2592000 seconds)
 */
function getSessionRedisTTLSeconds(): number {
  const ttlDays = process.env.SESSION_REDIS_TTL_DAYS || '30';
  const days = Number.parseInt(ttlDays, 10);
  const ttlSeconds = days * 24 * 60 * 60; // Convert days to seconds
  return ttlSeconds;
}

/**
 * Checks if a session status indicates the session is stopped/completed
 * @param status - Session status string
 * @returns true if session is stopped/completed
 */
export function isSessionStopped(status: string | null | undefined): boolean {
  if (!status) return false;
  const statusLower = status.toLowerCase();
  return (
    statusLower === 'time_reached' ||
    statusLower === 'completed' ||
    statusLower === 'cancelled'
  );
}

/**
 * Sets TTL on all Redis keys related to a stopped/completed session
 * Keys affected:
 * - session:sales:{sessionId}
 * - session:applied:{sessionId}
 *
 * This should be called whenever a session is marked as:
 * - TIME_REACHED (stopped)
 * - COMPLETED (max slots reached)
 * - CANCELLED (cancelled)
 *
 * @param sessionId - Session integer ID (from database `id` field, NOT `suid` UUID)
 * @param redisConnection - Optional Redis connection (creates one if not provided)
 * @returns Promise<boolean> - true if TTL was set successfully, false otherwise
 *
 */
export async function setSessionRedisTTL(
  sessionId: number,
  redisConnection?: IORedis,
): Promise<boolean> {
  try {
    const ttlSeconds = getSessionRedisTTLSeconds();
    const redis = redisConnection || createSalesSyncRedisConnection();
    const shouldCloseConnection = !redisConnection;

    const keys = [`session:sales:${sessionId}`, `session:applied:${sessionId}`];

    let successCount = 0;
    const errors: string[] = [];

    for (const key of keys) {
      try {
        // Check if key exists before setting TTL
        const exists = await redis.exists(key);
        if (exists) {
          await redis.expire(key, ttlSeconds);
          successCount++;
          logger.info(
            `Set TTL of ${ttlSeconds}s (${ttlSeconds / (24 * 60 * 60)} days) on Redis key: ${key}`,
          );
        } else {
          logger.debug(`Redis key ${key} does not exist, skipping TTL set`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`${key}: ${errorMessage}`);
        logger.warn(`Failed to set TTL on ${key}: ${errorMessage}`);
      }
    }

    // Close connection if we created it
    if (shouldCloseConnection) {
      await redis.quit();
    }

    if (errors.length > 0) {
      logger.warn(
        `Set TTL on ${successCount}/${keys.length} keys for session ${sessionId}. Errors: ${errors.join(', ')}`,
      );
    } else if (successCount > 0) {
      logger.info(
        `Successfully set TTL on ${successCount} Redis key(s) for session ${sessionId}`,
      );
    }

    return successCount > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to set TTL on Redis keys for session ${sessionId}: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    return false;
  }
}

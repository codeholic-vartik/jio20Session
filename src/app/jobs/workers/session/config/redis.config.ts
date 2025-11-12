/**
 * @fileoverview Redis connection configuration for session worker
 * @description Creates and configures Redis connection with error handling,
 * automatic reconnection, and event monitoring for BullMQ worker
 */

import IORedis from 'ioredis';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { normalizeRedisUrl } from '../../../../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../../../../common/utils/redis-db.util';

const logger: StandaloneLogger = createStandaloneLogger('SessionWorkerRedis');

/**
 * Creates Redis connection with proper error handling and retry logic
 *
 * @description
 * Configures a Redis connection specifically for BullMQ worker usage with:
 * - Automatic reconnection with exponential backoff
 * - Connection event monitoring and logging
 * - Error handling for various connection failure scenarios
 * - Environment-based URL configuration
 *
 * @returns {IORedis} Configured Redis connection instance
 *
 * @example
 * ```typescript
 * const connection = createRedisConnection();
 * // Use with BullMQ Worker
 * const worker = new Worker('queue-name', processor, { connection });
 * ```
 *
 * @environment
 * - REDIS_BULLMQ_URL: Primary Redis URL (preferred)
 * - REDIS_URL: Fallback Redis URL
 * - Defaults to: redis://localhost:6379
 */
export function createRedisConnection(): IORedis {
  const redisUrl = normalizeRedisUrl(
    process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || undefined,
  );

  // Use the same database index resolution as the queue connection
  // This ensures worker and queue use the same Redis database
  const dbIndex = resolveRedisDbIndex(redisUrl || '', {
    envNames: ['REDIS_BULLMQ_DB', 'REDIS_DB'],
  });

  logger.info(
    `Creating Redis connection for worker with database index: ${dbIndex} (resolved from REDIS_BULLMQ_DB=${process.env.REDIS_BULLMQ_DB || 'not set'}, REDIS_DB=${process.env.REDIS_DB || 'not set'})`,
  );

  const connection = new IORedis(redisUrl, {
    db: dbIndex, // Use the same database index as the queue
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

/**
 * Creates Redis connection specifically for sales sync operations
 * Uses REDIS_DB (not REDIS_BULLMQ_DB) to match where sales data is stored
 *
 * @description
 * This connection is used by the sync-sales handler to read sales counts
 * from Redis. It uses REDIS_DB to ensure it reads from the same database
 * where the subscriber stores sales data.
 *
 * @returns {IORedis} Configured Redis connection instance for sales sync
 */
export function createSalesSyncRedisConnection(): IORedis {
  const redisUrl = normalizeRedisUrl(
    process.env.REDIS_URL || process.env.REDIS_BULLMQ_URL || undefined,
  );

  // Use REDIS_DB only (not REDIS_BULLMQ_DB) to match where sales data is stored
  const dbIndex = resolveRedisDbIndex(redisUrl || '', {
    envNames: ['REDIS_DB'], // Only use REDIS_DB, not REDIS_BULLMQ_DB
  });

  logger.info(
    `Creating Redis connection for sales sync with database index: ${dbIndex} (resolved from REDIS_DB=${process.env.REDIS_DB || 'not set'})`,
  );

  const connection = new IORedis(redisUrl, {
    db: dbIndex,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 5000);
      logger.warn(
        `Sales sync Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
      );
      return delay;
    },
    reconnectOnError: (err) => {
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
          `Sales sync Redis error detected (${err.message}), attempting reconnection...`,
        );
        return true;
      }

      return false;
    },
    enableReadyCheck: true,
    lazyConnect: false,
    enableOfflineQueue: true,
    connectTimeout: 10000,
    keepAlive: 30000,
  });

  connection.on('error', (err) => {
    logger.error(`Sales sync Redis connection error: ${err.message}`);
  });

  connection.on('connect', () => {
    logger.info('Sales sync Redis connection established');
  });

  connection.on('ready', () => {
    logger.info('Sales sync Redis connection ready and operational');
  });

  connection.on('close', () => {
    logger.warn(
      'Sales sync Redis connection closed - will attempt to reconnect',
    );
  });

  connection.on('reconnecting', (delay: number) => {
    logger.warn(`Sales sync Redis reconnecting in ${delay}ms...`);
  });

  return connection;
}

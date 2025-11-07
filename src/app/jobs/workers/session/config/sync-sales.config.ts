/**
 * @fileoverview Configuration utilities for the sync-sales worker handler
 * @description Provides environment-driven configuration with sensible defaults.
 */

import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('SyncSalesConfig');

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 1000;

/**
 * Reads the batch size configuration for the sync-sales handler from the
 * environment. Falls back to a safe default when the value is missing or
 * invalid.
 *
 * @environment SESSION_SYNC_SALES_BATCH_SIZE - Positive integer (<= 1000)
 * @returns {number} Batch size to use for Redis and database operations
 */
export function getSyncSalesBatchSize(): number {
  const rawValue = process.env.SESSION_SYNC_SALES_BATCH_SIZE;

  if (rawValue === undefined || rawValue.trim().length === 0) {
    return DEFAULT_BATCH_SIZE;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid SESSION_SYNC_SALES_BATCH_SIZE="${rawValue}" - falling back to default ${DEFAULT_BATCH_SIZE}`,
    );
    return DEFAULT_BATCH_SIZE;
  }

  if (parsed > MAX_BATCH_SIZE) {
    logger.warn(
      `SESSION_SYNC_SALES_BATCH_SIZE=${parsed} exceeds max ${MAX_BATCH_SIZE} - clamping to ${MAX_BATCH_SIZE}`,
    );
    return MAX_BATCH_SIZE;
  }

  return parsed;
}

/**
 * Expose the default for testing or documentation purposes.
 */
export const defaultSyncSalesBatchSize = DEFAULT_BATCH_SIZE;

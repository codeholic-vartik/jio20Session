/**
 * @fileoverview Orphan coupon processing job handler
 * @description Processes orphan coupons (coupons with no session) every 5 minutes
 * - Finds orphan coupons and assigns them to upcoming sessions
 * - Checks sales thresholds before assignment
 * - Processes refunds when no sessions available or threshold reached
 */

import { Job } from 'bullmq';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { OrphanCouponService } from '../services/orphan-coupon.service';

const logger: StandaloneLogger = createStandaloneLogger('OrphanCouponHandler');

/**
 * Handles orphan-coupon-processing job
 *
 * @description
 * Processes all orphan coupons (coupons with session_id: null) and:
 * 1. Finds upcoming sessions for each coupon's term_id
 * 2. Checks sales threshold from Redis (total sales vs trigger count)
 * 3. Assigns coupons to sessions if threshold not reached
 * 4. Processes refunds if threshold reached or no sessions found
 * 5. Updates Redis sales counts atomically
 *
 * @param {Job} job - BullMQ job instance
 * @returns {Promise<Object>} Result object with processing statistics
 * @returns {boolean} returns.success - Whether processing completed successfully
 * @returns {number} returns.processed - Total coupons processed
 * @returns {number} returns.assigned - Number of coupons assigned to sessions
 * @returns {number} returns.refunded - Number of coupons refunded
 * @returns {number} returns.errors - Number of errors encountered
 *
 * @example
 * ```typescript
 * // Job is automatically routed here when job.name === 'process-orphan-coupons'
 * const result = await handleOrphanCoupons(job);
 * // Returns: { success: true, processed: 10, assigned: 8, refunded: 2, errors: 0 }
 * ```
 */
export async function handleOrphanCoupons(job: Job): Promise<{
  success: boolean;
  processed: number;
  assigned: number;
  refunded: number;
  errors: number;
}> {
  const startTime = Date.now();
  try {
    logger.info(
      `Starting orphan coupon processing job: id=${job.id}, attempt=${job.attemptsMade + 1}, timestamp=${new Date().toISOString()}`,
    );

    const stats = await OrphanCouponService.processOrphanCoupons();

    const duration = Date.now() - startTime;
    logger.info(
      `Orphan coupon processing completed in ${duration}ms: processed=${stats.processed}, assigned=${stats.assigned}, refunded=${stats.refunded}, errors=${stats.errors}`,
    );

    return {
      success: true,
      processed: stats.processed,
      assigned: stats.assigned,
      refunded: stats.refunded,
      errors: stats.errors,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Orphan coupon processing job failed after ${duration}ms: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}

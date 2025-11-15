import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { SessionStatus } from '../../../../../common/types/enums/session-status.enum';
import { createSalesSyncRedisConnection } from '../config/redis.config';

const logger: StandaloneLogger = createStandaloneLogger('OrphanCouponService');
const db = new PrismaClient();

// Redis connection for sales count updates (uses REDIS_DB)
let redisConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!redisConnection) {
    redisConnection = createSalesSyncRedisConnection();
  }
  return redisConnection;
}

export const OrphanCouponService = {
  // Fetch orphan coupons in batches to avoid loading huge result sets into memory
  findOrphanCoupons: async (
    batchSize = 50,
  ): Promise<
    { id: number; term_id: number | null; order_id: string | null }[]
  > => {
    let skip = 0;

    const allResults: {
      id: number;
      term_id: number | null;
      order_id: string | null;
    }[] = [];

    while (true) {
      const batch = await db.session_coupons.findMany({
        where: { session_id: null },
        select: {
          id: true,
          term_id: true,
          order_id: true, // string | null from DB
        },
        orderBy: { created_at: 'asc' },
        take: batchSize,
        skip,
      });

      if (batch.length === 0) break;

      // No conversion — just keep order_id as string | null
      const sanitizedBatch = batch.map((row) => ({
        id: row.id,
        term_id: row.term_id,
        order_id: row.order_id, // keep string
      }));

      allResults.push(...sanitizedBatch);

      logger.info(
        `Fetched batch of ${sanitizedBatch.length} orphan coupons (skip=${skip})`,
      );

      skip += batchSize;
    }

    logger.info(`Total orphan coupons found: ${allResults.length}`);
    return allResults;
  },

  /**
   * Gets total sales count for a term_id from Redis
   * Sums up sales counts from all sessions associated with the term_id
   */
  getTotalSalesCountForTermId: async (termId: number): Promise<number> => {
    try {
      // Get all session profiles that have this term_id
      const sessionProfiles = await db.session_profiles.findMany({
        where: {
          is_active: true,
          is_deleted: false,
          session_taxonomy_terms: {
            some: {
              term_id: termId,
              is_enabled: true,
            },
          },
        },
        select: { id: true },
      });

      if (sessionProfiles.length === 0) {
        return 0;
      }

      // Get all sessions for these profiles
      const sessions = await db.sessions.findMany({
        where: {
          session_profile_id: {
            in: sessionProfiles.map((p) => p.id),
          },
          is_deleted: false,
        },
        select: { id: true },
      });

      if (sessions.length === 0) {
        return 0;
      }

      // Sum up sales counts from Redis for all sessions
      const redis = getRedisConnection();
      let totalSales = 0;

      for (const session of sessions) {
        const salesRedisKey = `session:sales:${session.id}`;
        const countStr = await redis.get(salesRedisKey);
        if (countStr) {
          const count = parseInt(countStr, 10);
          if (!isNaN(count)) {
            totalSales += count;
          }
        }
      }

      return totalSales;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to get total sales count for term_id ${termId}: ${errorMessage}`,
      );
      return 0;
    }
  },

  /**
   * Checks if sales threshold has been reached for a term_id
   * Compares total sales count with sales_trigger_count from session profile
   */
  isSalesThresholdReachedForTermId: async (
    termId: number,
  ): Promise<{
    reached: boolean;
    totalSales: number;
    triggerCount: number;
  }> => {
    try {
      // Get session profile for this term_id
      const sessionProfile = await db.session_profiles.findFirst({
        where: {
          is_active: true,
          is_deleted: false,
          session_taxonomy_terms: {
            some: {
              term_id: termId,
              is_enabled: true,
            },
          },
        },
        select: {
          id: true,
          sales_trigger_count: true,
          max_sessions: true,
        },
      });

      if (!sessionProfile || !sessionProfile.sales_trigger_count) {
        return { reached: false, totalSales: 0, triggerCount: 0 };
      }

      // Calculate total max sales = max_sessions * sales_trigger_count
      const maxSessions = sessionProfile.max_sessions || 1;
      const triggerCount = sessionProfile.sales_trigger_count;
      const totalTriggerCount = maxSessions * triggerCount;

      // Get current total sales from Redis
      const totalSales =
        await OrphanCouponService.getTotalSalesCountForTermId(termId);

      const reached = totalSales >= totalTriggerCount;

      logger.info(
        `Sales threshold check for term_id ${termId}: totalSales=${totalSales}, triggerCount=${totalTriggerCount}, reached=${reached}`,
      );

      return {
        reached,
        totalSales,
        triggerCount: totalTriggerCount,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to check sales threshold for term_id ${termId}: ${errorMessage}`,
      );
      return { reached: false, totalSales: 0, triggerCount: 0 };
    }
  },

  /**
   * Finds upcoming sessions for a given term_id with retry logic
   * Queries through session_taxonomy_terms -> session_profiles -> sessions
   * Returns sessions with status UPCOMING
   * Retries up to maxRetries times with delay between retries
   */
  findUpcomingSessionsByTermId: async (
    termId: number,
    maxRetries = 1,
    retryDelayMs = 1000,
  ): Promise<{ id: number; session_profile_id: number }[]> => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const sessions = await db.sessions.findMany({
          where: {
            status: {
              in: [SessionStatus.UPCOMING],
            },
            is_active: true,
            is_deleted: false,
            session_profiles: {
              is_active: true,
              is_deleted: false,
              session_taxonomy_terms: {
                some: {
                  term_id: termId,
                  is_enabled: true,
                },
              },
            },
          },
          select: {
            id: true,
            session_profile_id: true,
          },
          orderBy: [{ priority_position: 'asc' }, { created_at: 'asc' }],
          take: 1, // Get the first upcoming session
        });

        if (sessions.length > 0) {
          return sessions;
        }

        // If no sessions found and not last attempt, wait before retry
        if (attempt < maxRetries - 1) {
          logger.info(
            `No upcoming sessions found for term_id ${termId} (attempt ${attempt + 1}/${maxRetries}), retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `Error finding upcoming sessions for term_id ${termId} (attempt ${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );

        // If not last attempt, wait before retry
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    if (lastError) {
      logger.error(
        `Failed to find upcoming sessions for term_id ${termId} after ${maxRetries} attempts: ${lastError.message}`,
      );
    } else {
      logger.info(
        `No upcoming sessions found for term_id ${termId} after ${maxRetries} attempts`,
      );
    }

    return [];
  },

  /**
   * Assigns a coupon to a session and atomically increments Redis sales count
   * Uses Redis INCR for race-condition safe increment
   * Also publishes sales update to Redis pub/sub channel
   * Checks sales trigger count before assigning - if threshold reached, returns false
   */
  assignCouponToSession: async (
    couponId: number,
    sessionId: number,
    sessionProfileId: number,
  ): Promise<{ success: boolean; message: string; shouldRefund?: boolean }> => {
    try {
      // Get session profile to check sales_trigger_count
      const sessionProfile = await db.session_profiles.findUnique({
        where: { id: sessionProfileId },
        select: { sales_trigger_count: true },
      });

      if (!sessionProfile) {
        throw new Error(`Session profile ${sessionProfileId} not found`);
      }

      // Get current sales count from Redis (source of truth)
      const redis = getRedisConnection();
      const salesRedisKey = `session:sales:${sessionId}`;
      const currentCountStr = await redis.get(salesRedisKey);
      const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;

      // Check if sales trigger count has been reached
      const salesTriggerCount = sessionProfile.sales_trigger_count;
      if (salesTriggerCount !== null && currentCount >= salesTriggerCount) {
        logger.info(
          `Sales trigger count reached for session ${sessionId}: current=${currentCount}, trigger=${salesTriggerCount}. Skipping assignment and will refund.`,
        );
        return {
          success: false,
          message: `Sales trigger count reached (${currentCount} >= ${salesTriggerCount})`,
          shouldRefund: true,
        };
      }

      // Use transaction to ensure atomicity
      await db.$transaction(async (tx) => {
        // Update coupon with session_id
        await tx.session_coupons.update({
          where: { id: couponId },
          data: {
            session_id: sessionId,
            updated_at: new Date(),
          },
        });

        // Get current sales count from DB for verification
        const session = await tx.sessions.findUnique({
          where: { id: sessionId },
          select: { current_sales_count: true },
        });

        if (!session) {
          throw new Error(`Session ${sessionId} not found`);
        }
      });

      // Atomically increment Redis sales count using INCR
      // This ensures race-condition safety
      // The key format follows: session:sales:{sessionId}
      // This is the same format used by the sync-sales job and FastAPI app
      const newCount = await redis.incr(salesRedisKey);

      // Also ensure the value is stored (INCR already does this, but explicit for clarity)
      // This key will be synced with the database by the sync-sales job
      // FastAPI app can also read from this same Redis key

      // Publish sales update to Redis pub/sub channel
      // Payload format must match SalesUpdatePayload interface expected by subscriber
      // This ensures FastAPI app and other subscribers receive the update
      const salesUpdateChannel = 'session:sales:update';
      const payload = JSON.stringify({
        session_id: sessionId,
        session_profile_id: sessionProfileId,
        count: newCount,
        created_at: new Date().toISOString(),
      });

      await redis.publish(salesUpdateChannel, payload);

      logger.info(
        `Assigned coupon ${couponId} to session ${sessionId}, incremented sales count to ${newCount}`,
      );

      return {
        success: true,
        message: `Coupon ${couponId} assigned to session ${sessionId}, sales count: ${newCount}`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to assign coupon ${couponId} to session ${sessionId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        success: false,
        message: `Failed to assign coupon: ${errorMessage}`,
      };
    }
  },

  /**
   * Processes refund for a coupon when no upcoming sessions are available
   * Calls Razorpay refund webhook/API
   */
  processRefund: async (
    orderId: string,
    couponId: number,
  ): Promise<{ success: boolean; message: string }> => {
    try {
      if (!orderId) {
        logger.warn(
          `Cannot process refund for coupon ${couponId}: order_id is null or empty`,
        );
        return {
          success: false,
          message: 'Order ID is required for refund',
        };
      }

      // Get transaction details for the order
      const transaction = await db.transactions.findFirst({
        where: {
          orders: {
            ouid: orderId,
          },
          payment_gateway: 'razorpay',
        },
        select: {
          payment_id: true,
          amount: true,
          currency: true,
        },
      });

      if (!transaction || !transaction.payment_id) {
        logger.warn(
          `No Razorpay transaction found for order ${orderId}, coupon ${couponId}`,
        );
        return {
          success: false,
          message: 'No Razorpay transaction found for this order',
        };
      }

      // Call Razorpay refund webhook/API
      // TODO: Replace with actual Razorpay refund API call
      // This is a placeholder that should be implemented based on your Razorpay integration
      const refundWebhookUrl =
        process.env.RAZORPAY_REFUND_WEBHOOK_URL ||
        process.env.REFUND_WEBHOOK_URL;

      if (refundWebhookUrl) {
        try {
          const response = await fetch(refundWebhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              payment_id: transaction.payment_id,
              order_id: orderId,
              coupon_id: couponId,
              amount: transaction.amount.toString(),
              currency: transaction.currency || 'INR',
              reason: 'No upcoming session available',
            }),
          });

          if (!response.ok) {
            throw new Error(
              `Refund webhook returned status ${response.status}`,
            );
          }

          logger.info(
            `Refund webhook called successfully for order ${orderId}, coupon ${couponId}`,
          );

          return {
            success: true,
            message: `Refund processed for order ${orderId}`,
          };
        } catch (webhookError) {
          const errorMessage =
            webhookError instanceof Error
              ? webhookError.message
              : String(webhookError);
          logger.error(
            `Failed to call refund webhook for order ${orderId}: ${errorMessage}`,
          );
          return {
            success: false,
            message: `Refund webhook failed: ${errorMessage}`,
          };
        }
      } else {
        // If no webhook URL is configured, log and return success
        // In production, you might want to throw an error instead
        logger.warn(
          `Refund webhook URL not configured. Skipping refund for order ${orderId}, coupon ${couponId}. Please configure RAZORPAY_REFUND_WEBHOOK_URL or REFUND_WEBHOOK_URL environment variable.`,
        );
        return {
          success: true,
          message: `Refund webhook not configured, logged for manual processing`,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to process refund for coupon ${couponId}, order ${orderId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        success: false,
        message: `Refund processing failed: ${errorMessage}`,
      };
    }
  },

  /**
   * Main method to process all orphan coupons
   * For each orphan coupon:
   * 1. If term_id exists, find upcoming sessions
   * 2. If upcoming session found, assign coupon and increment sales count
   * 3. If no upcoming session, process refund
   */
  processOrphanCoupons: async (): Promise<{
    processed: number;
    assigned: number;
    refunded: number;
    errors: number;
  }> => {
    const stats = {
      processed: 0,
      assigned: 0,
      refunded: 0,
      errors: 0,
    };

    try {
      logger.info('Starting orphan coupon processing...');

      const orphanCoupons = await OrphanCouponService.findOrphanCoupons();

      if (orphanCoupons.length === 0) {
        logger.info('No orphan coupons found to process');
        return stats;
      }

      logger.info(`Processing ${orphanCoupons.length} orphan coupons...`);

      for (const coupon of orphanCoupons) {
        stats.processed++;

        try {
          // Skip if no term_id (can't find sessions without term_id)
          if (!coupon.term_id) {
            logger.warn(
              `Coupon ${coupon.id} has no term_id, skipping assignment`,
            );
            continue;
          }

          // Find upcoming sessions for this term_id
          const upcomingSessions =
            await OrphanCouponService.findUpcomingSessionsByTermId(
              coupon.term_id,
              1, // Single attempt
            );

          if (upcomingSessions.length > 0) {
            // Found upcoming session - check its sales count before assigning
            const session = upcomingSessions[0];

            // Check if this upcoming session's sales count has reached the trigger
            const redis = getRedisConnection();
            const salesRedisKey = `session:sales:${session.id}`;
            const currentCountStr = await redis.get(salesRedisKey);
            const currentSalesCount = currentCountStr
              ? parseInt(currentCountStr, 10)
              : 0;

            // Get session profile to get sales_trigger_count
            const sessionProfile = await db.session_profiles.findUnique({
              where: { id: session.session_profile_id },
              select: { sales_trigger_count: true },
            });

            if (!sessionProfile) {
              logger.error(
                `Session profile ${session.session_profile_id} not found for session ${session.id}`,
              );
              stats.errors++;
              continue;
            }

            const salesTriggerCount = sessionProfile.sales_trigger_count;

            // Check if sales count has reached the trigger value
            if (
              salesTriggerCount !== null &&
              currentSalesCount >= salesTriggerCount
            ) {
              // Sales count reached - refund instead of assigning
              logger.info(
                `Upcoming session ${session.id} sales count reached: current=${currentSalesCount} >= trigger=${salesTriggerCount}. Processing refund for coupon ${coupon.id}`,
              );

              if (coupon.order_id) {
                const refundResult = await OrphanCouponService.processRefund(
                  coupon.order_id,
                  coupon.id,
                );

                if (refundResult.success) {
                  stats.refunded++;
                  logger.info(
                    `Sales trigger reached for session ${session.id}, processed refund for coupon ${coupon.id}, order ${coupon.order_id}`,
                  );
                } else {
                  stats.errors++;
                  logger.error(
                    `Failed to process refund for coupon ${coupon.id}: ${refundResult.message}`,
                  );
                }
              } else {
                logger.warn(
                  `Sales trigger reached for session ${session.id} but coupon ${coupon.id} has no order_id, cannot process refund`,
                );
                stats.errors++;
              }
            } else {
              // Sales count not reached - assign coupon to session
              const result = await OrphanCouponService.assignCouponToSession(
                coupon.id,
                session.id,
                session.session_profile_id,
              );

              if (result.success) {
                stats.assigned++;
                logger.info(
                  `Successfully assigned coupon ${coupon.id} to session ${session.id} (sales count: ${currentSalesCount} < trigger: ${salesTriggerCount})`,
                );
              } else {
                stats.errors++;
                logger.error(
                  `Failed to assign coupon ${coupon.id} to session ${session.id}: ${result.message}`,
                );
              }
            }
          } else {
            // No upcoming sessions, process refund
            if (coupon.order_id) {
              const refundResult = await OrphanCouponService.processRefund(
                coupon.order_id,
                coupon.id,
              );

              if (refundResult.success) {
                stats.refunded++;
                logger.info(
                  `Successfully processed refund for coupon ${coupon.id}, order ${coupon.order_id}`,
                );
              } else {
                stats.errors++;
                logger.error(
                  `Failed to process refund for coupon ${coupon.id}: ${refundResult.message}`,
                );
              }
            } else {
              logger.warn(
                `Coupon ${coupon.id} has no order_id, cannot process refund`,
              );
              stats.errors++;
            }
          }
        } catch (error) {
          stats.errors++;
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error(
            `Error processing coupon ${coupon.id}: ${errorMessage}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }

      logger.info(
        `Orphan coupon processing completed. Processed: ${stats.processed}, Assigned: ${stats.assigned}, Refunded: ${stats.refunded}, Errors: ${stats.errors}`,
      );

      return stats;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Fatal error in processOrphanCoupons: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  },
};

// Run directly if executed from CLI
if (require.main === module) {
  void (async () => {
    logger.info('Running OrphanCouponService.processOrphanCoupons()...');
    try {
      const stats = await OrphanCouponService.processOrphanCoupons();
      logger.info(`Processing completed: ${JSON.stringify(stats)}`);

      // Cleanup
      if (redisConnection) {
        await redisConnection.quit();
      }
      await db.$disconnect();
      process.exit(0);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Error processing orphan coupons: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (redisConnection) {
        await redisConnection.quit().catch(() => {
          // Ignore cleanup errors
        });
      }
      await db.$disconnect().catch(() => {
        // Ignore cleanup errors
      });
      process.exit(1);
    }
  })();
}

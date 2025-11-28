import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import Razorpay from 'razorpay';
// Stripe will be installed via npm install
// Using dynamic import to handle case where package might not be installed yet

let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  Stripe = require('stripe');
} catch {
  // Stripe not installed yet - will be available after npm install
  Stripe = null;
}
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { SessionStatus } from '../../../../../common/types/enums/session-status.enum';
import { createSalesSyncRedisConnection } from '../config/redis.config';
import { getRazorpayConfig } from '../config/razorpay.config';
import { getStripeConfig } from '../config/stripe.config';

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
        where: { session_id: null, is_valid: true },
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
   * Processes Razorpay refund for a payment
   * @private
   */
  processRazorpayRefund: async (
    transaction: {
      payment_id: string;
      amount: number;
      currency: string | null;
    },
    orderId: string,
    couponId: number,
  ): Promise<{ success: boolean; message: string }> => {
    try {
      // Get Razorpay credentials from config
      const razorpayConfig = getRazorpayConfig();

      // Validate Razorpay credentials
      if (!razorpayConfig.client || !razorpayConfig.secret) {
        logger.error(
          `Razorpay credentials not configured. Cannot process refund for order ${orderId}, coupon ${couponId}. Please configure RAZORPAY_CLIENT and RAZORPAY_SECRET environment variables.`,
        );
        return {
          success: false,
          message: 'Razorpay credentials not configured',
        };
      }

      // Initialize Razorpay client
      const razorpay = new Razorpay({
        key_id: razorpayConfig.client,
        key_secret: razorpayConfig.secret,
      });

      // Convert amount to paise (Razorpay uses smallest currency unit)
      // transaction.amount is Decimal, convert to number and multiply by 100
      const amountInPaise = Math.round(Number(transaction.amount) * 100);

      // Create refund using Razorpay SDK
      // Razorpay automatically processes refund to user's original payment method
      const refundData: {
        amount: number;
        notes?: Record<string, string>;
      } = {
        amount: amountInPaise, // Amount in paise
        notes: {
          reason: 'No upcoming session available',
          order_id: orderId,
          coupon_id: couponId.toString(),
        },
      };

      logger.info(
        `Processing Razorpay refund for payment ${transaction.payment_id}, order ${orderId}, amount: ${amountInPaise} paise (₹${(amountInPaise / 100).toFixed(2)})`,
      );

      // Create refund using payments.refund() method
      const refund = await razorpay.payments.refund(
        transaction.payment_id,
        refundData,
      );

      // Log refund details - Razorpay automatically processes refund to user's original payment method
      logger.info(
        `Razorpay refund created successfully for order ${orderId}, coupon ${couponId}. Refund ID: ${refund.id}, Status: ${refund.status}, Amount: ${refund.amount} paise (₹${(refund.amount / 100).toFixed(2)}). Refund will be processed to user's original payment method.`,
      );

      // Additional info about refund processing
      if (refund.status === 'processed') {
        logger.info(
          `Refund ${refund.id} has been processed and funds have been returned to the user.`,
        );
      } else if (refund.status === 'pending') {
        logger.info(
          `Refund ${refund.id} is pending. Razorpay will process it to the user's account within 5-7 business days.`,
        );
      }

      return {
        success: true,
        message: `Refund processed successfully. Refund ID: ${refund.id}, Status: ${refund.status}. Amount ₹${(refund.amount / 100).toFixed(2)} will be refunded to user's payment method.`,
      };
    } catch (razorpayError: unknown) {
      let errorMessage: string;
      let detailedError: string;

      // Check if it's a Razorpay API error with more details
      if (
        razorpayError &&
        typeof razorpayError === 'object' &&
        'error' in razorpayError
      ) {
        const apiError = razorpayError as { error: { description?: string } };
        if (apiError.error?.description) {
          detailedError = apiError.error.description;
          errorMessage = detailedError;
        } else {
          errorMessage = JSON.stringify(razorpayError);
          detailedError = errorMessage;
        }
      } else if (razorpayError instanceof Error) {
        errorMessage = razorpayError.message;
        detailedError = errorMessage;
      } else {
        errorMessage = JSON.stringify(razorpayError);
        detailedError = errorMessage;
      }

      logger.error(
        `Failed to process Razorpay refund for order ${orderId}, coupon ${couponId}: ${detailedError}`,
        razorpayError instanceof Error ? razorpayError.stack : undefined,
      );

      return {
        success: false,
        message: `Razorpay refund failed: ${detailedError}`,
      };
    }
  },

  /**
   * Processes Stripe refund for a payment
   * @private
   */
  processStripeRefund: async (
    transaction: {
      payment_id: string;
      amount: number;
      currency: string | null;
    },
    orderId: string,
    couponId: number,
  ): Promise<{ success: boolean; message: string }> => {
    try {
      // Get Stripe credentials from config
      const stripeConfig = getStripeConfig();

      // Validate Stripe credentials
      if (!stripeConfig.secretKey) {
        logger.error(
          `Stripe credentials not configured. Cannot process refund for order ${orderId}, coupon ${couponId}. Please configure STRIPE_SECRET_KEY environment variable.`,
        );
        return {
          success: false,
          message: 'Stripe credentials not configured',
        };
      }

      // Check if Stripe is available
      if (!Stripe) {
        throw new Error(
          'Stripe package is not installed. Please run: npm install stripe',
        );
      }

      // Initialize Stripe client
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const stripe = new Stripe(stripeConfig.secretKey, {
        apiVersion: '2024-12-18.acacia',
      });

      // Convert amount to cents (Stripe uses smallest currency unit)
      // transaction.amount is Decimal, convert to number and multiply by 100
      const amountInCents = Math.round(Number(transaction.amount) * 100);

      logger.info(
        `Processing Stripe refund for payment ${transaction.payment_id}, order ${orderId}, amount: ${amountInCents} cents (₹${(amountInCents / 100).toFixed(2)})`,
      );

      // Detect the type of Stripe ID and use appropriate parameter
      // Charge IDs start with 'ch_', Payment Intent IDs start with 'pi_'
      const paymentId = transaction.payment_id;
      const isChargeId = paymentId.startsWith('ch_');
      const isPaymentIntentId = paymentId.startsWith('pi_');

      if (!isChargeId && !isPaymentIntentId) {
        logger.error(
          `Invalid Stripe payment ID format: ${paymentId}. Expected charge ID (ch_...) or payment intent ID (pi_...)`,
        );
        return {
          success: false,
          message: `Invalid Stripe payment ID format. Expected charge ID (ch_...) or payment intent ID (pi_...), got: ${paymentId}`,
        };
      }

      // Prepare refund parameters based on ID type
      const refundParams: {
        amount: number;
        metadata: Record<string, string>;
        charge?: string;
        payment_intent?: string;
      } = {
        amount: amountInCents,
        metadata: {
          reason: 'No upcoming session available',
          order_id: orderId,
          coupon_id: couponId.toString(),
        },
      };

      if (isChargeId) {
        refundParams.charge = paymentId;
        logger.info(`Using charge ID for refund: ${paymentId}`);
      } else if (isPaymentIntentId) {
        refundParams.payment_intent = paymentId;
        logger.info(`Using payment intent ID for refund: ${paymentId}`);
      }

      // Create refund using Stripe SDK
      // Stripe automatically processes refund to user's original payment method
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const refund = (await stripe.refunds.create(refundParams)) as {
        id: string;
        status: string;
        amount: number;
      };

      // Log refund details
      logger.info(
        `Stripe refund created successfully for order ${orderId}, coupon ${couponId}. Refund ID: ${refund.id}, Status: ${refund.status}, Amount: ${refund.amount} cents (₹${(refund.amount / 100).toFixed(2)}). Refund will be processed to user's original payment method.`,
      );

      // Additional info about refund processing
      if (refund.status === 'succeeded') {
        logger.info(
          `Refund ${refund.id} has been processed and funds have been returned to the user.`,
        );
      } else if (refund.status === 'pending') {
        logger.info(
          `Refund ${refund.id} is pending. Stripe will process it to the user's account within 5-10 business days.`,
        );
      }

      return {
        success: true,
        message: `Refund processed successfully. Refund ID: ${refund.id}, Status: ${refund.status}. Amount ₹${(refund.amount / 100).toFixed(2)} will be refunded to user's payment method.`,
      };
    } catch (stripeError: unknown) {
      let errorMessage: string;
      let detailedError: string;

      // Check if it's a Stripe API error with more details
      if (
        stripeError &&
        typeof stripeError === 'object' &&
        'type' in stripeError &&
        'message' in stripeError
      ) {
        // Stripe error object
        const stripeErr = stripeError as { message: string; type?: string };
        detailedError = stripeErr.message;
        errorMessage = detailedError;
      } else if (stripeError instanceof Error) {
        errorMessage = stripeError.message;
        detailedError = errorMessage;
      } else {
        errorMessage = JSON.stringify(stripeError);
        detailedError = errorMessage;
      }

      logger.error(
        `Failed to process Stripe refund for order ${orderId}, coupon ${couponId}: ${detailedError}`,
        stripeError instanceof Error ? stripeError.stack : undefined,
      );

      return {
        success: false,
        message: `Stripe refund failed: ${detailedError}`,
      };
    }
  },

  /**
   * Processes refund for a coupon when no upcoming sessions are available
   * Supports multiple payment gateways (Razorpay, Stripe)
   * Automatically detects payment gateway from transaction and routes to appropriate handler
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

      // Get transaction details for the order (without filtering by payment_gateway)
      const transaction = await db.transactions.findFirst({
        where: {
          orders: {
            ouid: orderId,
          },
        },
        select: {
          payment_id: true,
          payment_gateway: true,
          amount: true,
          currency: true,
        },
      });

      if (!transaction || !transaction.payment_id) {
        logger.warn(
          `No transaction found for order ${orderId}, coupon ${couponId}`,
        );
        return {
          success: false,
          message: 'No transaction found for this order',
        };
      }

      // Normalize payment gateway name (case-insensitive)
      const paymentGateway = transaction.payment_gateway.toLowerCase();

      // Route to appropriate refund handler based on payment gateway
      let refundResult: { success: boolean; message: string };

      if (paymentGateway === 'razorpay') {
        refundResult = await OrphanCouponService.processRazorpayRefund(
          {
            payment_id: transaction.payment_id,
            amount: Number(transaction.amount),
            currency: transaction.currency,
          },
          orderId,
          couponId,
        );
      } else if (paymentGateway === 'stripe') {
        refundResult = await OrphanCouponService.processStripeRefund(
          {
            payment_id: transaction.payment_id,
            amount: Number(transaction.amount),
            currency: transaction.currency,
          },
          orderId,
          couponId,
        );
      } else {
        logger.error(
          `Unsupported payment gateway: ${paymentGateway} for order ${orderId}, coupon ${couponId}`,
        );
        return {
          success: false,
          message: `Unsupported payment gateway: ${paymentGateway}. Supported gateways: razorpay, stripe`,
        };
      }

      // If refund was successful, mark coupon as invalid
      if (refundResult.success) {
        try {
          await db.session_coupons.update({
            where: { id: couponId },
            data: { is_valid: false },
          });
          logger.info(
            `Successfully marked coupon ${couponId} as invalid (is_valid = false) after refund processing.`,
          );
        } catch (updateError) {
          const updateErrorMessage =
            updateError instanceof Error
              ? updateError.message
              : String(updateError);
          logger.error(
            `Failed to mark coupon ${couponId} as invalid after refund: ${updateErrorMessage}`,
            updateError instanceof Error ? updateError.stack : undefined,
          );
          // Don't fail the entire refund if coupon update fails
          // The refund was successful, so we still return success
        }
      }

      return refundResult;
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

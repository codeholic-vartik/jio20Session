/**
 * @fileoverview Apply coupon job handler
 * @description Processes coupon applications in FIFO order from queue
 * - Uses Redis atomic operations for 100% accurate max slots check
 * - No DB locks to avoid bottlenecks
 * - Processes requests in order based on request timestamp
 */

import { Job } from 'bullmq';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { DatabaseService } from '../../../../../common/database/database.service';
import { SessionStatus } from '../../../../../common/types/enums/session-status.enum';
import IORedis from 'ioredis';
import { normalizeRedisUrl } from '../../../../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../../../../common/utils/redis-db.util';

const logger: StandaloneLogger = createStandaloneLogger('ApplyCouponHandler');

// Initialize Redis connection for this handler
let redis: IORedis | null = null;

function initRedis() {
  try {
    const redisUrl = normalizeRedisUrl(process.env.REDIS_URL || undefined);
    const dbIndex = resolveRedisDbIndex(redisUrl, {
      envNames: ['REDIS_DB'],
    });

    redis = new IORedis(redisUrl, {
      db: dbIndex,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });

    redis.on('error', (err) => {
      logger.warn(`Redis connection error: ${err.message}`);
    });
  } catch {
    logger.warn('Redis not available');
    redis = null;
  }
}

initRedis();

function getRedis(): IORedis | null {
  if (redis && redis.status === 'ready') {
    return redis;
  }
  return null;
}

/**
 * Handles apply-coupon job
 *
 * @description
 * Processes coupon applications queued from the API endpoint.
 * Jobs are processed in FIFO order based on request timestamp.
 * Uses Redis atomic operations for accurate max slots checking.
 *
 * @param {Job} job - BullMQ job instance with coupon application data
 * @returns {Promise<Object>} Result object with application details
 */
export async function handleApplyCoupon(job: Job): Promise<{
  success: boolean;
  position: number;
  is_winner: boolean;
  applied_at: Date;
  max_slots: number;
  slots_remaining: number | null;
  reward_created: boolean;
  participant_count: number;
}> {
  const { userId, couponId, sessionId, requestTimestamp } = job.data as {
    userId: number;
    couponId: number;
    sessionId: number;
    plainCouponCode: string;
    requestTimestamp: number;
  };

  logger.log(
    `Processing coupon application: user_id=${userId}, coupon_id=${couponId}, session_id=${sessionId}, request_timestamp=${requestTimestamp}`,
  );

  // Initialize services (we can't use DI in worker, so create instances)
  const prisma = new DatabaseService();

  // Load coupon
  const coupon = await prisma.session_coupons.findUnique({
    where: { id: couponId },
  });

  if (!coupon) {
    throw new Error(`Coupon not found: ${couponId}`);
  }

  // Validate coupon ownership
  if (coupon.user_id !== userId) {
    throw new Error(`User ${userId} does not own coupon ${couponId}`);
  }

  if (!coupon.is_valid) {
    throw new Error(`Coupon ${couponId} is not valid`);
  }

  if (coupon.is_redeemed) {
    throw new Error(`Coupon ${couponId} has already been applied`);
  }

  // Load session
  const session = await prisma.sessions.findUnique({
    where: { id: sessionId },
    include: {
      session_profiles: true,
    },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (session.status !== SessionStatus.LIVE.valueOf()) {
    throw new Error(
      `Session ${sessionId} is not LIVE (status: ${session.status})`,
    );
  }

  // Load profile
  const profile = await prisma.session_profiles.findUnique({
    where: { id: session.session_profile_id },
  });

  if (!profile) {
    throw new Error(`Session profile not found: ${session.session_profile_id}`);
  }

  const maxSlots = profile.max_slots;

  // Sync Redis counter with DB if needed
  if (maxSlots > 0) {
    const redisClient = getRedis();
    if (redisClient) {
      try {
        const appliedCount = await prisma.session_coupons.count({
          where: {
            session_id: sessionId,
            applied_at: { not: null },
          },
        });

        const redisKey = `session:applied:${sessionId}`;
        const redisCount = await redisClient.get(redisKey);
        const redisCountNum = redisCount ? Number.parseInt(redisCount, 10) : 0;

        if (redisCountNum !== appliedCount) {
          logger.log(
            `Syncing Redis counter: session=${sessionId}, Redis=${redisCountNum}, DB=${appliedCount}`,
          );
          await redisClient.set(redisKey, appliedCount.toString());
        }
      } catch (error) {
        logger.warn(
          `Failed to sync Redis counter: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Use Redis Lua script to atomically assign position with max_slots check
  const positionResult = await incrementSessionAppliedWithMaxSlotsCheck(
    sessionId,
    maxSlots,
  );

  if (positionResult === null) {
    throw new Error(
      `Session ${sessionId} has reached maximum slots (${maxSlots})`,
    );
  }

  const { position, is_winner: isWinner } = positionResult;

  // Check if coupon already applied (with atomic update to prevent race condition)
  // Use updateMany with condition to ensure only one job can update
  const appliedAt = new Date();
  const updateResult = await prisma.session_coupons.updateMany({
    where: {
      id: couponId,
      applied_at: null, // Only update if not already applied
    },
    data: {
      applied_at: appliedAt,
      position,
      is_redeemed: true,
      status: isWinner ? 'WINNER' : 'APPLIED_LATE',
    },
  });

  // If no rows were updated, coupon was already applied by another job
  if (updateResult.count === 0) {
    // Revert Redis counter since we couldn't apply the coupon
    const redisClient = getRedis();
    if (redisClient) {
      try {
        await redisClient.decr(`session:applied:${sessionId}`);
      } catch (error) {
        logger.warn(`Failed to revert Redis counter: ${error}`);
      }
    }

    // Check if it was already applied or doesn't exist
    const currentCoupon = await prisma.session_coupons.findUnique({
      where: { id: couponId },
    });

    if (!currentCoupon) {
      throw new Error(`Coupon not found: ${couponId}`);
    }

    if (currentCoupon.applied_at !== null) {
      throw new Error(
        `Coupon ${couponId} has already been applied (position: ${currentCoupon.position})`,
      );
    }

    throw new Error(
      `Failed to apply coupon ${couponId} - may have been updated concurrently`,
    );
  }

  // Create reward if winner
  let rewardCreated = false;
  if (isWinner) {
    await prisma.session_rewards.create({
      data: {
        session_id: sessionId,
        user_id: userId,
        session_coupon_id: couponId,
        reward_type: profile.reward_type,
        reward_value: profile.reward_value,
        reward_currency: profile.reward_currency,
        reward_product_id: profile.reward_product_id,
        reward_coupon_id: profile.reward_coupon_id,
        reward_metadata: profile.reward_metadata,
        status: 'PENDING',
      },
    });
    rewardCreated = true;
    logger.log(
      `Created reward: user_id=${userId}, session_id=${sessionId}, position=${position}`,
    );
  }

  // Update session
  const newParticipantCount = (session.current_participant_count || 0) + 1;
  await prisma.sessions.update({
    where: { id: sessionId },
    data: {
      current_participant_count: newParticipantCount,
      ...(maxSlots > 0 && position === maxSlots
        ? {
            status: SessionStatus.COMPLETED,
            end_time: new Date(),
            is_active: false,
          }
        : {}),
    },
  });

  if (maxSlots > 0 && position === maxSlots) {
    logger.log(
      `Session ${sessionId} reached max_slots (${maxSlots}) at position ${position}`,
    );
  }

  // Publish participant update
  const redisClient = getRedis();
  if (redisClient) {
    try {
      const channel = 'session:participant:update';
      const payload = JSON.stringify({
        suid: session.suid,
        participant_count: newParticipantCount,
        session_profile_id: session.session_profile_id,
        position,
        is_winner: isWinner,
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      });
      await redisClient.publish(channel, payload);
    } catch (error) {
      logger.warn(`Failed to publish participant update: ${error}`);
    }
  }

  return {
    success: true,
    position,
    is_winner: isWinner,
    applied_at: appliedAt,
    max_slots: maxSlots,
    slots_remaining: maxSlots > 0 ? Math.max(0, maxSlots - position) : null,
    reward_created: rewardCreated,
    participant_count: newParticipantCount,
  };
}

/**
 * Redis Lua script to atomically increment session applied count
 * and check max_slots - returns null if max_slots exceeded
 */
async function incrementSessionAppliedWithMaxSlotsCheck(
  sessionId: number,
  maxSlots: number,
): Promise<{ position: number; is_winner: boolean } | null> {
  const redisClient = getRedis();
  if (!redisClient) {
    return null;
  }

  try {
    const redisKey = `session:applied:${sessionId}`;
    const luaScript = `
      local key = KEYS[1]
      local max_slots = tonumber(ARGV[1])
      local current = redis.call('GET', key)
      if current == false then
        current = 0
      else
        current = tonumber(current)
      end
      
      if max_slots > 0 and current >= max_slots then
        return nil
      end
      
      local new_count = redis.call('INCR', key)
      local is_winner = max_slots == 0 or new_count <= max_slots
      
      return {new_count, is_winner and 1 or 0}
    `;

    const result = (await redisClient.eval(
      luaScript,
      1,
      redisKey,
      maxSlots.toString(),
    )) as [number, number] | null;

    if (!result) {
      return null;
    }

    return {
      position: result[0],
      is_winner: result[1] === 1,
    };
  } catch (error) {
    logger.warn(
      `Redis operation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

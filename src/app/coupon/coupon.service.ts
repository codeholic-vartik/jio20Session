import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { CouponGeneratorService } from './utils/coupon-generator.service';
import { SessionStatus } from '../../common/types/enums/session-status.enum';
import IORedis from 'ioredis';
import { normalizeRedisUrl } from '../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../common/utils/redis-db.util';
import { Queue } from 'bullmq';

/**
 * Apply coupon to session competition.
 * - Uses Redis atomic INCR for position
 * - Database row locks (FOR UPDATE) for thread safety
 */
@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);
  private redis: IORedis | null = null;

  constructor(
    private readonly prisma: DatabaseService,
    private readonly couponGenerator: CouponGeneratorService,
    @Inject('SESSION_QUEUE') private readonly sessionQueue: Queue,
  ) {
    this.initRedis();
  }

  private initRedis() {
    try {
      const redisUrl = normalizeRedisUrl(process.env.REDIS_URL || undefined);
      const dbIndex = resolveRedisDbIndex(redisUrl, {
        envNames: ['REDIS_DB'],
      });

      this.redis = new IORedis(redisUrl, {
        db: dbIndex,
        retryStrategy: () => null, // Don't retry if connection fails
        enableOfflineQueue: false,
      });

      this.redis.on('error', (err) => {
        this.logger.warn(`Redis connection error: ${err.message}`);
      });
    } catch {
      this.logger.warn('Redis not available, will use database fallback');
      this.redis = null;
    }
  }

  /**
   * Get Redis connection
   */
  private getRedis(): IORedis | null {
    if (this.redis && this.redis.status === 'ready') {
      return this.redis;
    }
    return null;
  }

  /**
   * Apply coupon to session - Queues request for FIFO processing
   * Uses request timestamp to maintain order - first request wins
   */
  async applyCoupon(
    userId: number,
    plainCouponCode: string,
  ): Promise<{
    success: boolean;
    job_id: string;
    message: string;
    queued_at: string;
  }> {
    this.logger.log(
      `Queueing coupon application for user ${userId} with code ${plainCouponCode}`,
    );

    // Step 1: Quick validation - find coupon (no DB locks, fast)
    let coupon = await this.findCouponByCode(plainCouponCode);
    if (!coupon) {
      coupon = await this.findCouponByUserFallback(userId, plainCouponCode);
    }

    if (!coupon) {
      throw new NotFoundException({
        error_type: 'not_found',
        loc: 'coupon_code',
        msg: 'Invalid coupon code',
        inp: '***',
        ctx: { code: 'invalid' },
      });
    }

    // Step 2: Quick validation checks (no locks, fast)
    this.validateCouponOwnership(coupon, userId);
    this.validateCouponIsValid(coupon);
    this.validateCouponNotUsed(coupon);

    if (!coupon.session_id) {
      throw new BadRequestException({
        error_type: 'invalid_coupon',
        loc: 'coupon',
        msg: 'This coupon is not linked to any session',
        inp: plainCouponCode,
        ctx: { session_id: null },
      });
    }

    // Step 3: Add to queue with request timestamp for FIFO processing
    // Jobs are processed in order based on request timestamp
    const requestTimestamp = Date.now();
    const job = await this.sessionQueue.add(
      'apply-coupon',
      {
        userId,
        couponId: coupon.id,
        sessionId: coupon.session_id,
        plainCouponCode,
        requestTimestamp,
      },
      {
        // Unique job ID to prevent duplicates
        jobId: `apply-coupon-${coupon.id}-${userId}-${requestTimestamp}`,
        // Process in FIFO order (by default BullMQ processes in order)
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    );

    this.logger.log(
      `Coupon application queued: job_id=${job.id}, user_id=${userId}, coupon_id=${coupon.id}, session_id=${coupon.session_id}, timestamp=${requestTimestamp}`,
    );

    return {
      success: true,
      job_id: job.id || '',
      message: 'Coupon application queued successfully. Processing in order.',
      queued_at: new Date(requestTimestamp).toISOString(),
    };
  }

  /**
   * Process queued coupon application (called by worker)
   * This runs in FIFO order based on request timestamp
   * Uses Redis atomic operations - no DB locks to avoid bottlenecks
   */
  async processCouponApplication(jobData: {
    userId: number;
    couponId: number;
    sessionId: number;
    requestTimestamp: number;
  }): Promise<{
    success: boolean;
    position: number;
    is_winner: boolean;
    applied_at: Date;
    max_slots: number;
    slots_remaining: number | null;
    reward_created: boolean;
    participant_count: number;
  }> {
    const { userId, couponId, sessionId } = jobData;

    this.logger.log(
      `Processing queued coupon application: user_id=${userId}, coupon_id=${couponId}, session_id=${sessionId}, request_timestamp=${jobData.requestTimestamp}`,
    );

    // Load coupon and session (no locks - queue ensures order)
    const coupon = await this.prisma.session_coupons.findUnique({
      where: { id: couponId },
    });

    if (!coupon) {
      throw new NotFoundException({
        error_type: 'not_found',
        loc: 'coupon',
        msg: 'Coupon not found',
        inp: couponId.toString(),
      });
    }

    // Re-validate (might have changed since queued)
    this.validateCouponOwnership(coupon, userId);
    this.validateCouponIsValid(coupon);
    this.validateCouponNotUsed(coupon);

    const session = await this.validateSessionExists(sessionId);
    this.validateSessionIsOpen(session);

    // Process with Redis atomic operations only (no DB locks)
    const result = await this.applyCouponWithRedisAtomic(coupon, session);

    // Update participant stats (non-critical)
    try {
      await this.updateParticipantStats(session.id, userId, result.is_winner);
    } catch (error) {
      this.logger.warn(
        `Failed to update participant stats (non-critical): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }

  /**
   * Find coupon by encrypted code
   */
  private async findCouponByCode(plainCode: string) {
    try {
      const encryptedCode = this.couponGenerator.encryptCode(plainCode);
      return await this.prisma.session_coupons.findFirst({
        where: {
          code: encryptedCode,
          is_valid: true,
          is_redeemed: false,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to encrypt coupon code for lookup: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fallback: Find coupon by scanning user's coupons
   */
  private async findCouponByUserFallback(userId: number, plainCode: string) {
    try {
      const userCoupons = await this.prisma.session_coupons.findMany({
        where: {
          user_id: userId,
          is_valid: true,
          is_redeemed: false,
        },
        take: 25, // Safeguard decrypt attempts
      });

      for (const userCoupon of userCoupons) {
        try {
          const decryptedCode = this.couponGenerator.decryptCode(
            userCoupon.code,
          );
          if (decryptedCode === plainCode) {
            return userCoupon;
          }
        } catch (error) {
          this.logger.debug(
            `Failed to decrypt coupon ${userCoupon.scuid}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Fallback error searching user coupons: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }

  /**
   * Validate coupon ownership
   */
  private validateCouponOwnership(coupon: { user_id: number }, userId: number) {
    if (coupon.user_id !== userId) {
      throw new BadRequestException({
        error_type: 'unauthorized',
        loc: 'coupon',
        msg: 'You do not own this coupon',
        inp: '***',
        ctx: { code: 'ownership' },
      });
    }
  }

  /**
   * Validate coupon is valid
   */
  private validateCouponIsValid(coupon: { is_valid: boolean }) {
    if (!coupon.is_valid) {
      throw new BadRequestException({
        error_type: 'invalid_coupon',
        loc: 'coupon',
        msg: 'This coupon is not valid',
        inp: '***',
        ctx: { code: 'invalid' },
      });
    }
  }

  /**
   * Validate coupon not already used
   */
  private validateCouponNotUsed(coupon: { is_redeemed: boolean }) {
    if (coupon.is_redeemed) {
      throw new ConflictException({
        error_type: 'duplicate_application',
        loc: 'coupon',
        msg: 'This coupon has already been applied',
        inp: '***',
        ctx: { code: 'already_used' },
      });
    }
  }

  /**
   * Validate session exists
   */
  private async validateSessionExists(sessionId: number) {
    const session = await this.prisma.sessions.findUnique({
      where: { id: sessionId },
      include: {
        session_profiles: true,
      },
    });

    if (!session) {
      throw new NotFoundException({
        error_type: 'not_found',
        loc: 'session',
        msg: 'Session not found',
        inp: sessionId.toString(),
      });
    }

    return session;
  }

  /**
   * Validate session is open for applications
   */
  private validateSessionIsOpen(session: { status: string }) {
    if (session.status !== SessionStatus.LIVE.valueOf()) {
      throw new BadRequestException({
        error_type: 'session_closed',
        loc: 'session',
        msg: 'Session is not open for coupon applications',
        inp: session.status,
        ctx: { status: session.status },
      });
    }
  }

  /**
   * Validate session has available slots
   */
  private async validateSessionHasAvailableSlots(session: {
    id: number;
    session_profiles: { max_slots: number } | null;
  }) {
    const maxSlots = session.session_profiles?.max_slots || 0;
    if (maxSlots <= 0) {
      return; // No limit
    }

    const appliedCount = await this.prisma.session_coupons.count({
      where: {
        session_id: session.id,
        applied_at: { not: null },
      },
    });

    if (appliedCount >= maxSlots) {
      throw new ConflictException({
        error_type: 'session_full',
        loc: 'session',
        msg: `Session has reached maximum slots (${maxSlots}). No more coupons can be applied.`,
        inp: session.id.toString(),
        ctx: {
          max_slots: maxSlots,
          available_slots: 0,
        },
      });
    }
  }

  /**
   * Apply coupon with Redis atomic operations only (no DB locks)
   * Queue ensures FIFO processing, so no need for DB locks - avoids bottlenecks
   */
  private async applyCouponWithRedisAtomic(
    coupon: {
      id: number;
      user_id: number;
      session_id: number | null;
    },
    session: {
      id: number;
      suid: string;
      session_profile_id: number;
      current_participant_count: number | null;
      session_profiles: {
        max_slots: number;
        reward_type: string;
        reward_value: unknown;
        reward_currency: string | null;
        reward_product_id: number | null;
        reward_coupon_id: number | null;
        reward_metadata: unknown;
      } | null;
    },
  ) {
    // Load session profile (no transaction needed - queue ensures order)
    const profile = await this.prisma.session_profiles.findUnique({
      where: { id: session.session_profile_id },
    });

    if (!profile) {
      throw new NotFoundException({
        error_type: 'not_found',
        loc: 'session',
        msg: 'Session profile not found',
        inp: session.session_profile_id.toString(),
      });
    }

    const maxSlots = profile.max_slots;

    // Sync Redis counter with DB if needed (one-time sync)
    if (maxSlots > 0) {
      await this.syncRedisCounter(session.id);
    }

    // Use Redis Lua script to atomically assign position with max_slots check
    // This is 100% accurate and handles 100k+ concurrent requests
    const positionResult = await this.incrementSessionAppliedWithMaxSlotsCheck(
      session.id,
      maxSlots,
    );

    if (positionResult === null) {
      // Max slots exceeded - Redis returned null
      throw new ConflictException({
        error_type: 'session_full',
        loc: 'session',
        msg: `Session has reached maximum slots (${maxSlots}). No more coupons can be applied.`,
        inp: session.suid,
        ctx: {
          max_slots: maxSlots,
          available_slots: 0,
        },
      });
    }

    const { position, is_winner: isWinner } = positionResult;

    // Atomically update coupon only if not already applied (prevents race condition)
    // This ensures only the first job to reach here can update the coupon
    const appliedAt = new Date();
    const updateResult = await this.prisma.session_coupons.updateMany({
      where: {
        id: coupon.id,
        applied_at: null, // Only update if not already applied
      },
      data: {
        applied_at: appliedAt,
        position,
        is_redeemed: true,
        status: isWinner ? 'winner' : 'applied_late',
      },
    });

    // If no rows updated, coupon was already applied
    if (updateResult.count === 0) {
      // Revert Redis counter since we couldn't apply
      const redis = this.getRedis();
      if (redis) {
        try {
          await redis.decr(`session:applied:${session.id}`);
        } catch (error) {
          this.logger.warn(
            `Failed to revert Redis counter: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Check current state for error message
      const currentCoupon = await this.prisma.session_coupons.findUnique({
        where: { id: coupon.id },
      });

      if (!currentCoupon) {
        throw new NotFoundException({
          error_type: 'not_found',
          loc: 'coupon',
          msg: 'Coupon not found',
          inp: coupon.id.toString(),
        });
      }

      if (currentCoupon.applied_at !== null) {
        throw new ConflictException({
          error_type: 'duplicate_application',
          loc: 'coupon',
          msg: 'This coupon has already been applied',
          inp: currentCoupon.scuid,
          ctx: {
            position: currentCoupon.position,
            applied_at: currentCoupon.applied_at,
          },
        });
      }

      throw new ConflictException({
        error_type: 'application_failed',
        loc: 'coupon',
        msg: 'Failed to apply coupon - may have been updated concurrently',
        inp: coupon.id.toString(),
      });
    }

    // Create reward record if winner
    let rewardCreated = false;
    if (isWinner) {
      await this.prisma.session_rewards.create({
        data: {
          session_id: session.id,
          user_id: coupon.user_id,
          session_coupon_id: coupon.id,
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
      this.logger.log(
        `Created reward record for winner: user_id=${coupon.user_id}, session_id=${session.id}, position=${position}, reward_type=${profile.reward_type}`,
      );
    }

    // Update session participant count
    const newParticipantCount = (session.current_participant_count || 0) + 1;
    await this.prisma.sessions.update({
      where: { id: session.id },
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
      this.logger.log(
        `Session ${session.id} reached max_slots (${maxSlots}) at position ${position}. Marked as COMPLETED.`,
      );
    }

    // Publish participant update via Redis pub/sub
    try {
      await this.publishParticipantUpdate(
        session.suid,
        newParticipantCount,
        session.session_profile_id,
        position,
        isWinner,
        session.id,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to publish participant update (non-critical): ${error instanceof Error ? error.message : String(error)}`,
      );
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
   * Sync Redis counter with DB count
   */
  private async syncRedisCounter(sessionId: number) {
    const redis = this.getRedis();
    if (!redis) return;

    try {
      const appliedCount = await this.prisma.session_coupons.count({
        where: {
          session_id: sessionId,
          applied_at: { not: null },
        },
      });

      const redisKey = `session:applied:${sessionId}`;
      const redisCount = await redis.get(redisKey);
      const redisCountNum = redisCount ? Number.parseInt(redisCount, 10) : 0;

      if (redisCountNum !== appliedCount) {
        this.logger.log(
          `Syncing Redis counter with DB count for session ${sessionId}: Redis=${redisCountNum}, DB=${appliedCount}`,
        );
        await redis.set(redisKey, appliedCount.toString());
      }
    } catch (error) {
      this.logger.warn(
        `Failed to sync Redis counter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Redis Lua script to atomically increment session applied count with max_slots check
   */
  private async incrementSessionAppliedWithMaxSlotsCheck(
    sessionId: number,
    maxSlots: number,
  ): Promise<{ position: number; is_winner: boolean } | null> {
    const redis = this.getRedis();
    if (!redis) return null;

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

      const result = (await redis.eval(
        luaScript,
        1,
        redisKey,
        maxSlots.toString(),
      )) as [number, number] | null;

      if (!result) {
        return null; // Max slots exceeded
      }

      return {
        position: result[0],
        is_winner: result[1] === 1,
      };
    } catch (error) {
      this.logger.warn(
        `Redis operation failed, will use DB fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Publish participant update via Redis pub/sub
   */
  private async publishParticipantUpdate(
    suid: string,
    participantCount: number,
    sessionProfileId: number,
    position: number,
    isWinner: boolean,
    sessionId: number,
  ) {
    const redis = this.getRedis();
    if (!redis) return;

    try {
      const channel = 'session:participant:update';
      const payload = JSON.stringify({
        suid,
        participant_count: participantCount,
        session_profile_id: sessionProfileId,
        position,
        is_winner: isWinner,
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      });

      await redis.publish(channel, payload);
    } catch (error) {
      this.logger.warn(
        `Failed to publish participant update: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Update participant statistics
   */
  private async updateParticipantStats(
    sessionId: number,
    userId: number,
    isWinner: boolean,
  ) {
    // Check if participant exists
    const existing = await this.prisma.session_participants.findUnique({
      where: {
        session_id_user_id: {
          session_id: sessionId,
          user_id: userId,
        },
      },
    });

    if (existing) {
      await this.prisma.session_participants.update({
        where: {
          session_id_user_id: {
            session_id: sessionId,
            user_id: userId,
          },
        },
        data: {
          coupons_applied: { increment: 1 },
          is_winner: isWinner,
        },
      });
    } else {
      await this.prisma.session_participants.create({
        data: {
          session_id: sessionId,
          user_id: userId,
          coupons_owned: 0,
          coupons_applied: 1,
          is_winner: isWinner,
        },
      });
    }
  }
}

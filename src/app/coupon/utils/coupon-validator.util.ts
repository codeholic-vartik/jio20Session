/**
 * @fileoverview Coupon validation utilities
 * @description Centralized coupon validation functions for reuse across service and handlers
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../../common/database/database.service';
import { SessionStatus } from '../../../common/types/enums/session-status.enum';

/**
 * Coupon validation error types
 */
export type CouponValidationError =
  | BadRequestException
  | ConflictException
  | NotFoundException
  | Error;

/**
 * Validate coupon ownership
 * @throws BadRequestException if user doesn't own coupon
 */
export function validateCouponOwnership(
  coupon: { user_id: number },
  userId: number,
): void {
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
 * @throws BadRequestException if coupon is invalid
 */
export function validateCouponIsValid(coupon: { is_valid: boolean }): void {
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
 * @throws ConflictException if coupon already applied
 */
export function validateCouponNotUsed(coupon: { is_redeemed: boolean }): void {
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
 * Get user win count for a specific session
 * Counts coupons with status 'winner' or 'WINNER' (case-insensitive)
 */
export async function getUserWinCountForSession(
  userId: number,
  sessionId: number,
  prisma: DatabaseService,
): Promise<number> {
  const winCount = await prisma.session_coupons.count({
    where: {
      user_id: userId,
      session_id: sessionId,
      applied_at: { not: null },
      OR: [{ status: 'winner' }, { status: 'WINNER' }, { status: 'Winner' }],
    },
  });

  return winCount;
}

/**
 * Invalidate all remaining coupons for a user in a session
 * Sets is_valid = false for all non-redeemed coupons
 */
export async function invalidateRemainingCouponsForSession(
  userId: number,
  sessionId: number,
  prisma: DatabaseService,
  logger?: { log: (message: string) => void },
): Promise<void> {
  const result = await prisma.session_coupons.updateMany({
    where: {
      user_id: userId,
      session_id: sessionId,
      is_redeemed: false,
      is_valid: true,
    },
    data: {
      is_valid: false,
    },
  });

  if (result.count > 0 && logger) {
    logger.log(
      `Invalidated ${result.count} remaining coupon(s) for user ${userId} in session ${sessionId}`,
    );
  }
}

/**
 * Validate user win count per session
 * Checks if user has reached the maximum allowed wins for this session
 * @throws ConflictException if user has reached max wins
 */
export async function validateUserWinCountPerSession(
  userId: number,
  sessionId: number,
  prisma: DatabaseService,
): Promise<void> {
  const maxApply = process.env.MAX_SESSION_COUPON_APPLY;
  if (!maxApply) {
    return; // No limit configured, skip validation
  }

  const maxApplyNum = Number.parseInt(maxApply, 10);
  if (isNaN(maxApplyNum) || maxApplyNum <= 0) {
    return; // Invalid value, skip validation
  }

  const winCount = await getUserWinCountForSession(userId, sessionId, prisma);

  if (winCount >= maxApplyNum) {
    // User has reached max, invalidate remaining coupons if configured
    const shouldInvalidate = process.env.COUPON_INVALIDATE === 'true' || false;
    if (shouldInvalidate) {
      await invalidateRemainingCouponsForSession(userId, sessionId, prisma);
    }

    throw new ConflictException({
      error_type: 'max_wins_reached',
      loc: 'coupon',
      msg: `You have already won ${winCount} time(s) in this session. Maximum allowed is ${maxApplyNum}.`,
      inp: sessionId.toString(),
      ctx: {
        wins_count: winCount,
        max_allowed: maxApplyNum,
        session_id: sessionId,
      },
    });
  }
}

/**
 * Check if user has reached max wins after a successful win
 * If so, invalidate remaining coupons if COUPON_INVALIDATE is enabled
 */
export async function checkAndInvalidateRemainingCouponsAfterWin(
  userId: number,
  sessionId: number,
  prisma: DatabaseService,
  logger?: { log: (message: string) => void },
): Promise<void> {
  const maxApply = process.env.MAX_SESSION_COUPON_APPLY;
  if (!maxApply) {
    return; // No limit configured, skip
  }

  const maxApplyNum = Number.parseInt(maxApply, 10);
  if (isNaN(maxApplyNum) || maxApplyNum <= 0) {
    return; // Invalid value, skip
  }

  const shouldInvalidate = process.env.COUPON_INVALIDATE === 'true' || false;
  if (!shouldInvalidate) {
    return; // Invalidation not enabled, skip
  }

  // Check current win count (including the one just applied)
  const winCount = await getUserWinCountForSession(userId, sessionId, prisma);

  if (winCount >= maxApplyNum) {
    // User has reached max, invalidate remaining coupons
    await invalidateRemainingCouponsForSession(
      userId,
      sessionId,
      prisma,
      logger,
    );
    if (logger) {
      logger.log(
        `User ${userId} reached max wins (${winCount}/${maxApplyNum}) in session ${sessionId}. Remaining coupons invalidated.`,
      );
    }
  }
}

/**
 * Validate session exists
 * @throws NotFoundException if session doesn't exist
 */
export async function validateSessionExists(
  sessionId: number,
  prisma: DatabaseService,
) {
  const session = await prisma.sessions.findUnique({
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
 * @throws BadRequestException if session is not LIVE
 */
export function validateSessionIsOpen(session: { status: string }): void {
  if (session.status !== SessionStatus.LIVE.valueOf()) {
    throw new BadRequestException({
      error_type: 'session_closed',
      loc: 'session',
      msg: `Session is not open for coupon applications. Current status: ${session.status}, required: ${SessionStatus.LIVE.valueOf()}`,
      inp: session.status,
      ctx: {
        status: session.status,
        required_status: SessionStatus.LIVE.valueOf(),
      },
    });
  }
}

/**
 * @fileoverview Expires unused coupons for a session once sales threshold is reached.
 * @description
 *  - Runs as a BullMQ job (`expire-session-coupons`)
 *  - Processes coupons in configurable batches (default: 500)
 *  - Marks remaining coupons as { status: 'expired', is_valid: false }
 *  - Safe to run multiple times (idempotent)
 */

import { Job } from 'bullmq';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';
import { DatabaseService } from '../../../../../common/database/database.service';
import { SessionStatus } from '../../../../../common/types/enums';

const logger: StandaloneLogger = createStandaloneLogger(
  'ExpireSessionCouponsHandler',
);

type ExpireSessionCouponsJobData = {
  sessionId: number;
  sessionProfileId: number;
  salesCount?: number;
  triggeredAt?: string;
  reason?: string;
  batchSize?: number;
};

const DEFAULT_BATCH_SIZE = Math.max(
  100,
  Number.parseInt(process.env.SESSION_COUPON_EXPIRE_BATCH_SIZE || '500', 10) ||
    500,
);
const MAX_BATCH_SIZE = 2000;

function resolveBatchSize(jobBatchSize?: number): number {
  if (
    jobBatchSize &&
    Number.isFinite(jobBatchSize) &&
    jobBatchSize > 0 &&
    jobBatchSize <= MAX_BATCH_SIZE
  ) {
    return Math.floor(jobBatchSize);
  }
  return Math.min(Math.max(DEFAULT_BATCH_SIZE, 100), MAX_BATCH_SIZE);
}

export async function handleExpireSessionCoupons(job: Job): Promise<{
  sessionId: number;
  sessionProfileId: number;
  expired: number;
  batches: number;
  skipped: boolean;
  reason?: string;
}> {
  const {
    sessionId,
    sessionProfileId,
    salesCount,
    triggeredAt,
    reason,
    batchSize: requestedBatchSize,
  } = job.data as ExpireSessionCouponsJobData;

  if (!sessionId || !sessionProfileId) {
    throw new Error(
      `Invalid job payload. sessionId=${sessionId}, sessionProfileId=${sessionProfileId}`,
    );
  }

  const prisma = new DatabaseService();
  const session = await prisma.sessions.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      session_profile_id: true,
      current_sales_count: true,
      status: true,
      session_profiles: {
        select: {
          sales_trigger_count: true,
        },
      },
    },
  });

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.session_profile_id !== sessionProfileId) {
    throw new Error(
      `Session ${sessionId} does not belong to profile ${sessionProfileId}`,
    );
  }

  if (session.status !== SessionStatus.COMPLETED.valueOf()) {
    logger.warn(
      `Session ${sessionId} is not completed yet (status=${session.status}). Skipping coupon expiration.`,
    );
    return {
      sessionId,
      sessionProfileId,
      expired: 0,
      batches: 0,
      skipped: true,
      reason: 'session_not_completed',
    };
  }

  const salesTriggerCount =
    session.session_profiles?.sales_trigger_count ?? null;

  if (!salesTriggerCount || salesTriggerCount <= 0) {
    logger.warn(
      `Session ${sessionId} has no sales_trigger_count configured. Skipping expiration.`,
    );
    return {
      sessionId,
      sessionProfileId,
      expired: 0,
      batches: 0,
      skipped: true,
      reason: 'no_sales_trigger_count',
    };
  }

  const dbSalesCount =
    typeof session.current_sales_count === 'number'
      ? session.current_sales_count
      : 0;
  const payloadSalesCount =
    typeof salesCount === 'number' && !Number.isNaN(salesCount)
      ? salesCount
      : 0;
  const effectiveSalesCount = Math.max(dbSalesCount, payloadSalesCount);

  if (effectiveSalesCount < salesTriggerCount) {
    logger.warn(
      `Skipping expiration for session ${sessionId}: sales ${effectiveSalesCount} < trigger ${salesTriggerCount}`,
    );
    return {
      sessionId,
      sessionProfileId,
      expired: 0,
      batches: 0,
      skipped: true,
      reason: 'threshold_not_reached',
    };
  }

  const batchSize = resolveBatchSize(requestedBatchSize);
  let totalExpired = 0;
  let batches = 0;

  logger.log(
    `Starting coupon expiration for session ${sessionId} (profile ${sessionProfileId}) with batchSize=${batchSize}, triggeredAt=${triggeredAt || 'n/a'}, reason=${reason || 'threshold_reached'}`,
  );

  while (true) {
    const coupons = await prisma.session_coupons.findMany({
      where: {
        session_id: sessionId,
        is_valid: true,
        is_redeemed: false,
        applied_at: null,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });

    if (coupons.length === 0) {
      break;
    }

    // Update coupons to expired status
    const couponIds = coupons.map((coupon) => coupon.id);
    const updateResult = await prisma.session_coupons.updateMany({
      where: { id: { in: couponIds } },
      data: {
        status: 'expired',
        is_valid: false,
        updated_at: new Date(),
      },
    });

    totalExpired += updateResult.count;
    batches += 1;

    logger.debug(
      `Expired batch ${batches} for session ${sessionId}: requested=${couponIds.length}, updated=${updateResult.count}`,
    );

    if (couponIds.length < batchSize) {
      break;
    }
  }

  if (totalExpired === 0) {
    logger.log(
      `No pending coupons to expire for session ${sessionId}. Likely already processed.`,
    );
  } else {
    logger.log(
      `Expired ${totalExpired} coupon(s) for session ${sessionId} in ${batches} batch(es).`,
    );
  }

  return {
    sessionId,
    sessionProfileId,
    expired: totalExpired,
    batches,
    skipped: totalExpired === 0,
    reason: totalExpired === 0 ? 'no_pending_coupons' : undefined,
  };
}

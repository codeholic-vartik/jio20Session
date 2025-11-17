import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { Queue, RepeatableJob, RepeatOptions } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { normalizeRedisUrl } from '../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../common/utils/redis-db.util';
import './workers/session/session.worker'; // Ensure worker auto-starts

// Suppress Redis version warnings from IORedis/BullMQ
// This warning appears when Redis version is < 6.2.0 but the app works fine
const suppressRedisVersionWarning = (): void => {
  const originalStdoutWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof process.stdout.write;
  const originalStderrWrite = process.stderr.write.bind(
    process.stderr,
  ) as typeof process.stderr.write;

  const shouldSuppress = (chunk: string | Buffer | Uint8Array): boolean => {
    const message = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return (
      message.includes('highly recommended to use a minimum Redis version') ||
      message.includes('Current: 6.0.16') ||
      message.includes('minimum Redis version of 6.2.0') ||
      message.includes(
        'It is highly recommended to use a minimum Redis version',
      )
    );
  };

  process.stdout.write = function (
    chunk: string | Buffer | Uint8Array,
    encoding?: BufferEncoding | (() => void),
    cb?: () => void,
  ): boolean {
    if (shouldSuppress(chunk)) {
      return true;
    }
    if (typeof encoding === 'function') {
      return originalStdoutWrite(chunk, encoding);
    }
    return originalStdoutWrite(chunk, encoding, cb);
  };

  process.stderr.write = function (
    chunk: string | Buffer | Uint8Array,
    encoding?: BufferEncoding | (() => void),
    cb?: () => void,
  ): boolean {
    if (shouldSuppress(chunk)) {
      return true;
    }
    if (typeof encoding === 'function') {
      return originalStderrWrite(chunk, encoding);
    }
    return originalStderrWrite(chunk, encoding, cb);
  };
};

// Apply suppression before any Redis connections are created
suppressRedisVersionWarning();

@Global()
@Module({
  providers: [
    {
      provide: 'BULLMQ_CONNECTION',
      useFactory: async (): Promise<IORedis> => {
        const url = normalizeRedisUrl(
          process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || undefined,
        );

        const logger = new Logger('BullMQConnection');
        const wantsTls = shouldUseTls(url);
        const rejectUnauthorized =
          process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
        const dbIndex = resolveRedisDbIndex(url, {
          envNames: ['REDIS_BULLMQ_DB', 'REDIS_DB'],
        });

        const options: RedisOptions = {
          ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
          db: dbIndex,
          maxRetriesPerRequest: null,
          retryStrategy: (times) => {
            const delay = Math.min(times * 200, 5000);
            logger.warn(
              `Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
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
            const shouldReconnect = reconnectErrors.some((e) =>
              err.message.includes(e),
            );
            if (shouldReconnect) {
              logger.warn(
                `Redis error detected (${err.message}), reconnecting...`,
              );
              return true;
            }
            return false;
          },
          enableReadyCheck: true,
          enableOfflineQueue: true,
          connectTimeout: 10000,
          keepAlive: 30000,
        };

        const client = new IORedis(url, options);

        // Register event handlers with proper logger
        client.on('error', (err) =>
          logger.error(`Redis connection error: ${err.message}`),
        );
        client.on('connect', () => logger.log('Redis connection established'));
        client.on('ready', () =>
          logger.log('Redis connection ready and operational'),
        );
        client.on('close', () =>
          logger.warn('Redis connection closed - attempting reconnect'),
        );
        client.on('reconnecting', (delay) =>
          logger.warn(`Redis reconnecting in ${delay}ms...`),
        );

        await checkEvictionPolicy(client).catch(() => {});
        return client;
      },
    },
    {
      provide: 'SESSION_QUEUE',
      useFactory: (connection: IORedis): Queue =>
        new Queue('session-jobs', { connection }),
      inject: ['BULLMQ_CONNECTION'],
    },
  ],
  exports: ['BULLMQ_CONNECTION', 'SESSION_QUEUE'],
})
export class BullmqModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullmqModule.name);

  constructor(
    @Inject('BULLMQ_CONNECTION') private readonly connection: IORedis,
    @Inject('SESSION_QUEUE') private readonly sessionQueue: Queue,
  ) {}

  /**
   * Helper to get repeatable jobs using non-deprecated API
   * Explicitly uses the signature without parameters to avoid deprecation warning
   */
  private async getRepeatableJobs(): Promise<RepeatableJob[]> {
    return this.sessionQueue.getRepeatableJobs();
  }

  /**
   * Helper to remove repeatable job using non-deprecated API
   * Uses removeRepeatable with options object instead of separate parameters
   */
  private async removeRepeatableJob(existing: RepeatableJob): Promise<void> {
    // Use removeRepeatable with options object - non-deprecated API in BullMQ v5
    // The new API uses an options object instead of separate parameters
    const repeatOptions: RepeatOptions = existing.pattern
      ? { pattern: existing.pattern }
      : existing.every
        ? {
            every:
              typeof existing.every === 'number'
                ? existing.every
                : parseInt(String(existing.every), 10),
          }
        : {};
    // Type assertion to use non-deprecated signature (without optional jobId parameter)
    await (
      this.sessionQueue.removeRepeatable as (
        name: string,
        repeatOptions: RepeatOptions,
      ) => Promise<boolean>
    )(existing.name, repeatOptions);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureOpeningSessionSyncJob();
    await this.scheduleSalesSyncJob();
    await this.scheduleOrphanCouponProcessingJob();
  }

  private async ensureOpeningSessionSyncJob(): Promise<void> {
    const intervalSeconds = parseInt(
      process.env.OPENING_SESSION_SYNC_INTERVAL_SECONDS || '30',
      10,
    );
    const repeatEveryMs = Math.max(intervalSeconds, 5) * 1000;

    try {
      const jobs = await this.getRepeatableJobs();
      const existing = jobs.find((j) => j.name === 'sync-opening-sessions');
      if (existing) {
        await this.removeRepeatableJob(existing);
        this.logger.log('Removed existing sync-opening-sessions job');
      }

      await this.sessionQueue.add(
        'sync-opening-sessions',
        {},
        {
          repeat: { every: repeatEveryMs },
          removeOnComplete: { age: 3600, count: 10 },
          removeOnFail: { age: 86400 },
        },
      );

      this.logger.log(
        `Scheduled opening session sync job every ${intervalSeconds}s`,
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to schedule opening session sync job: ${errMsg}`,
      );
    }
  }

  private async scheduleSalesSyncJob(): Promise<void> {
    const syncIntervalMinutes = parseInt(
      process.env.SALES_SYNC_INTERVAL_MINUTES || '5',
      10,
    );
    const intervalMs = Math.max(syncIntervalMinutes, 1) * 60 * 1000;

    try {
      const jobs = await this.getRepeatableJobs();
      const existing = jobs.find((j) => j.name === 'sync-sales');
      if (existing) {
        await this.removeRepeatableJob(existing);
        this.logger.log('Removed existing sync-sales recurring job');
      }

      await this.sessionQueue.add(
        'sync-sales',
        {},
        {
          repeat: { every: intervalMs },
          removeOnComplete: { age: 3600, count: 10 },
          removeOnFail: { age: 86400 },
        },
      );

      this.logger.log(
        `Scheduled sales sync job every ${syncIntervalMinutes} min(s)`,
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to schedule sales sync job: ${errMsg}`);
    }
  }

  private async scheduleOrphanCouponProcessingJob(): Promise<void> {
    const processingIntervalMinutes = parseInt(
      process.env.ORPHAN_COUPON_PROCESSING_INTERVAL_MINUTES || '5',
      10,
    );
    const intervalMs = Math.max(processingIntervalMinutes, 1) * 60 * 1000;

    try {
      const jobs = await this.getRepeatableJobs();
      const existing = jobs.find((j) => j.name === 'process-orphan-coupons');
      if (existing) {
        await this.removeRepeatableJob(existing);
        this.logger.log(
          'Removed existing process-orphan-coupons recurring job',
        );
      }

      // Schedule recurring job
      await this.sessionQueue.add(
        'process-orphan-coupons',
        {},
        {
          repeat: { every: intervalMs },
          removeOnComplete: { age: 3600, count: 10 },
          removeOnFail: { age: 86400 },
        },
      );

      // Also trigger immediately on startup (one-time job)
      await this.sessionQueue.add(
        'process-orphan-coupons',
        {},
        {
          removeOnComplete: { age: 3600, count: 10 },
          removeOnFail: { age: 86400 },
        },
      );

      this.logger.log(
        `Scheduled orphan coupon processing job every ${processingIntervalMinutes} min(s) (also triggered immediately)`,
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to schedule orphan coupon processing job: ${errMsg}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.quit();
  }
}

/* ------------------ Helper Functions ------------------ */

function shouldUseTls(url: string): boolean {
  const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();
  if (['true', '1', 'yes'].includes(tlsFlag)) return true;
  if (['false', '0', 'no'].includes(tlsFlag)) return false;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'rediss:') return true;
    const sslParam =
      parsedUrl.searchParams.get('ssl') || parsedUrl.searchParams.get('tls');
    return !!(sslParam && /^(1|true|yes)$/i.test(sslParam));
  } catch {
    return false;
  }
}

async function checkEvictionPolicy(client: IORedis): Promise<void> {
  try {
    const cfg = await client.config('GET', 'maxmemory-policy');
    // Avoid unsafe any assignment by being explicit with array shape
    const currentPolicy =
      Array.isArray(cfg) && typeof cfg[1] === 'string' ? cfg[1] : undefined;
    if (process.env.REDIS_ENFORCE_NOEVICTION === 'true') {
      if (currentPolicy !== 'noeviction') {
        await client.config('SET', 'maxmemory-policy', 'noeviction');
      }
    } else if (currentPolicy && currentPolicy !== 'noeviction') {
      console.warn(
        `IMPORTANT! Eviction policy is "${currentPolicy}". It should be "noeviction".`,
      );
    }
  } catch {
    // Ignore if CONFIG command fails
  }
}

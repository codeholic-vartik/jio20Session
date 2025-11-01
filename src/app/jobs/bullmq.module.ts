import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
// Import worker to ensure it starts processing jobs
import './workers/session.worker';

/**
 * Helper function to determine if TLS should be used
 */
function shouldUseTls(url: string): boolean {
  const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();

  // Explicit env flag takes precedence
  if (['true', '1', 'yes'].includes(tlsFlag)) return true;
  if (['false', '0', 'no'].includes(tlsFlag)) return false;

  // Infer from URL
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'rediss:') return true;

    const sslParam =
      parsedUrl.searchParams.get('ssl') || parsedUrl.searchParams.get('tls');
    if (sslParam && /^(1|true|yes)$/i.test(sslParam)) return true;
  } catch {
    // Invalid URL, default to false
  }

  return false;
}

/**
 * Helper function to extract database index from URL or env
 */
function getDbIndex(url: string): number {
  // Check env variable first
  const envDb = process.env.REDIS_DB;
  if (envDb && /^\d+$/.test(envDb)) {
    return Number(envDb);
  }

  // Try to extract from URL
  try {
    const parsedUrl = new URL(url);

    // Check path (e.g., redis://host:port/1)
    if (parsedUrl.pathname && parsedUrl.pathname.length > 1) {
      const pathDb = Number(parsedUrl.pathname.slice(1));
      if (!Number.isNaN(pathDb)) return pathDb;
    }

    // Check query param (e.g., redis://host:port?db=1)
    const qpDb = parsedUrl.searchParams.get('db');
    if (qpDb && /^\d+$/.test(qpDb)) {
      return Number(qpDb);
    }
  } catch {
    // Invalid URL, use default
  }

  return 0; // Default database
}

/**
 * Helper function to check and enforce Redis eviction policy
 */
async function checkEvictionPolicy(client: IORedis): Promise<void> {
  try {
    const cfg = await client.config('GET', 'maxmemory-policy');
    const currentPolicy = Array.isArray(cfg) ? (cfg[1] as string) : undefined;

    if (process.env.REDIS_ENFORCE_NOEVICTION === 'true') {
      if (currentPolicy !== 'noeviction') {
        await client.config('SET', 'maxmemory-policy', 'noeviction');
      }
    } else if (currentPolicy && currentPolicy !== 'noeviction') {
      // Only warn, don't enforce
      console.warn(
        'IMPORTANT! Eviction policy is %s. It should be "noeviction"',
        currentPolicy,
      );
    }
  } catch {
    // Redis config command failed, skip policy check
  }
}

@Global()
@Module({
  providers: [
    {
      provide: 'BULLMQ_CONNECTION',
      useFactory: async (): Promise<IORedis> => {
        const url =
          process.env.REDIS_BULLMQ_URL ||
          process.env.REDIS_URL ||
          'redis://127.0.0.1:6379';

        const wantsTls = shouldUseTls(url);
        const rejectUnauthorized =
          process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
        const dbIndex = getDbIndex(url);

        const options: RedisOptions = {
          ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
          db: dbIndex,
        };

        const client = new IORedis(url, options);

        // Check eviction policy (non-blocking)
        await checkEvictionPolicy(client);

        return client;
      },
    },
    {
      provide: 'SESSION_QUEUE',
      useFactory: (connection: IORedis): Queue => {
        return new Queue('session-jobs', { connection });
      },
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
   * Initialize recurring jobs when module starts
   */
  async onModuleInit(): Promise<void> {
    // Schedule sales count sync job to run every 5 minutes
    // This syncs Redis sales count to database for all active sessions
    const syncIntervalMinutes = parseInt(
      process.env.SALES_SYNC_INTERVAL_MINUTES || '5',
      10,
    );

    if (syncIntervalMinutes < 1) {
      this.logger.warn(
        'SALES_SYNC_INTERVAL_MINUTES must be >= 1, defaulting to 5 minutes',
      );
    }

    const intervalMs = Math.max(syncIntervalMinutes, 1) * 60 * 1000;

    try {
      // Remove any existing recurring job with the same name to avoid duplicates
      const repeatableJobs = await this.sessionQueue.getRepeatableJobs();
      const existingSyncJob = repeatableJobs.find(
        (job) => job.name === 'sync-sales',
      );

      if (existingSyncJob) {
        await this.sessionQueue.removeRepeatableByKey(existingSyncJob.key);
        this.logger.log('Removed existing sync-sales recurring job');
      }

      // Add new recurring job
      await this.sessionQueue.add(
        'sync-sales',
        {},
        {
          repeat: {
            every: intervalMs,
          },
          removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 10, // Keep last 10 completed jobs
          },
          removeOnFail: {
            age: 86400, // Keep failed jobs for 24 hours
          },
        },
      );

      this.logger.log(
        `Scheduled sales count sync job to run every ${syncIntervalMinutes} minute(s)`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to schedule sales sync job: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      // Don't throw - allow module to continue even if scheduling fails
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.quit();
  }
}

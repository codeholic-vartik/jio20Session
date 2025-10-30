import { Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || 'redis://localhost:6379');

export const sessionWorker = new Worker(
  'session-jobs',
  async (job) => {
    if (job.name === 'rotate-session') {
      return { rotated: true };
    }
    return { ok: true };
  },
  { connection },
);

export const defaultJobOptions: JobsOptions = { attempts: 3, backoff: { type: 'exponential', delay: 2000 } };



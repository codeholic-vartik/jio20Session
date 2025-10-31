import { Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(
  process.env.REDIS_BULLMQ_URL ||
    process.env.REDIS_URL ||
    'redis://localhost:6379',
);

export const sessionWorker = new Worker(
  'session-jobs',
  async (job) => {
    if (job.name === 'rotate-session') {
      return Promise.resolve({ rotated: true });
    }

    if (job.name === 'threshold-reached') {
      const { sessionId, sessionProfileId } = job.data as {
        sessionId: number;
        sessionProfileId: number;
      };

      // TODO: Implement threshold reached logic here
      // This could include:
      // - Creating next session
      // - Processing winner
      // - Updating session status
      // - Notifying relevant services

      console.log(
        `WORKER: Processing threshold reached - session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
      );

      return Promise.resolve({
        processed: true,
        sessionId,
        sessionProfileId,
        timestamp: new Date().toISOString(),
      });
    }

    return Promise.resolve({ ok: true });
  },
  { connection },
);

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

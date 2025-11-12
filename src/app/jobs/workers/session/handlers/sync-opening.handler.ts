import { Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { syncOpeningSessionsToLive } from '../../session-transition.helper';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger(
  'SyncOpeningSessionsHandler',
);
const prisma = new PrismaClient();

export async function handleSyncOpeningSessions(job: Job): Promise<{
  checked: number;
  transitioned: number;
  skipped: number;
  errors: number;
}> {
  logger.info(`Starting sync-opening-sessions job: id=${job.id}`);
  try {
    const result = await syncOpeningSessionsToLive(prisma);
    logger.info(
      `Synced opening sessions: checked=${result.checked}, transitioned=${result.transitioned}, skipped=${result.skipped}, errors=${result.errors}`,
    );
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to sync opening sessions: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw error;
  }
}

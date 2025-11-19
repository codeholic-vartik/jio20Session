/**
 * @fileoverview Session Counter Service
 * @description Manages real-time counters for sessions using Redis
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { RedisOptions } from 'ioredis';
import { normalizeRedisUrl } from '../../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../../common/utils/redis-db.util';
import { KEYS } from '../constants';

/**
 * Service for managing session counters in Redis
 * Provides methods to increment, get, and set counter values
 */
@Injectable()
export class SessionCounterService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionCounterService.name);
  private readonly redisConnection: IORedis;

  constructor() {
    this.redisConnection = this.createRedisConnection();
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisConnection.quit();
  }

  /**
   * Get sales count for a session or taxonomy
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   * @returns Current count, or 0 if not found
   */
  async getSalesCount(
    type: 'session' | 'taxonomy',
    id: string | number,
  ): Promise<number> {
    try {
      const key = KEYS.getSessionSalesRedisKey(String(id));

      this.logger.debug(`Getting sales count: ${key}`);
      const count = await this.redisConnection.get(key);

      const numericCount = count ? parseInt(count, 10) : 0;

      this.logger.debug(`Retrieved sales count: ${key} -> ${numericCount}`);

      return numericCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to get sales count for ${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }

  private createRedisConnection(): IORedis {
    const redisUrl = normalizeRedisUrl(
      process.env.REDIS_URL || process.env.REDIS_BULLMQ_URL || undefined,
    );
    const dbIndex = resolveRedisDbIndex(redisUrl, {
      envNames: ['REDIS_DB'],
    });
    const wantsTls = this.shouldUseTls(redisUrl);
    const rejectUnauthorized =
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';

    const options: RedisOptions = {
      ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
      db: dbIndex,
      retryStrategy: (times) => {
        const delay = Math.min(times * 200, 5000);
        this.logger.warn(
          `Session counter Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
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
        const shouldReconnect = reconnectErrors.some((errorType) =>
          err.message.includes(errorType),
        );
        if (shouldReconnect) {
          this.logger.warn(
            `Session counter Redis error detected (${err.message}), attempting reconnection...`,
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

    const client = new IORedis(redisUrl, options);
    client.on('error', (err) =>
      this.logger.error(`Session counter Redis error: ${err.message}`),
    );
    client.on('connect', () =>
      this.logger.log(
        `Session counter Redis connection established (db=${dbIndex})`,
      ),
    );
    client.on('close', () =>
      this.logger.warn('Session counter Redis connection closed'),
    );
    client.on('reconnecting', (delay) =>
      this.logger.warn(
        `Session counter Redis reconnecting in ${delay}ms (db=${dbIndex})`,
      ),
    );

    return client;
  }

  private shouldUseTls(redisUrl: string): boolean {
    const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();
    if (['true', '1', 'yes'].includes(tlsFlag)) return true;
    if (['false', '0', 'no'].includes(tlsFlag)) return false;

    try {
      const url = new URL(redisUrl);
      if (url.protocol === 'rediss:') return true;
      const sslParam =
        url.searchParams.get('ssl') || url.searchParams.get('tls');
      if (sslParam && /^(1|true|yes)$/i.test(sslParam)) return true;
    } catch {
      // ignore
    }

    return false;
  }
}

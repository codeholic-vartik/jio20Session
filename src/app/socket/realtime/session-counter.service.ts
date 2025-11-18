/**
 * @fileoverview Session Counter Service
 * @description Manages real-time counters for sessions using Redis
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import IORedis from 'ioredis';
import { getSessionSalesCountKey } from './session-redis.keys';

/**
 * Service for managing session counters in Redis
 * Provides methods to increment, get, and set counter values
 */
@Injectable()
export class SessionCounterService {
  private readonly logger = new Logger(SessionCounterService.name);

  constructor(
    @Inject('BULLMQ_CONNECTION') private readonly redisConnection: IORedis,
  ) {}

  /**
   * Increment sales count for a session or taxonomy
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   * @param incrementBy - Amount to increment (default: 1)
   * @returns The new count after increment
   */
  async incrementSalesCount(
    type: 'session' | 'taxonomy',
    id: string,
    incrementBy: number = 1,
  ): Promise<number> {
    try {
      const key = getSessionSalesCountKey(type, id);
      const newCount = await this.redisConnection.incrby(key, incrementBy);

      this.logger.debug(
        `Incremented ${type} sales count: ${key} by ${incrementBy} -> ${newCount}`,
      );

      return newCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to increment sales count for ${type}:${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get sales count for a session or taxonomy
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   * @returns Current count, or 0 if not found
   */
  async getSalesCount(
    type: 'session' | 'taxonomy',
    id: string,
  ): Promise<number> {
    try {
      const key = getSessionSalesCountKey(type, id);
      const count = await this.redisConnection.get(key);

      const numericCount = count ? parseInt(count, 10) : 0;

      this.logger.debug(
        `Retrieved ${type} sales count: ${key} -> ${numericCount}`,
      );

      return numericCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to get sales count for ${type}:${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }

  /**
   * Set sales count for a session or taxonomy
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   * @param count - The count value to set
   */
  async setSalesCount(
    type: 'session' | 'taxonomy',
    id: string,
    count: number,
  ): Promise<void> {
    try {
      const key = getSessionSalesCountKey(type, id);
      await this.redisConnection.set(key, count.toString());

      this.logger.debug(`Set ${type} sales count: ${key} -> ${count}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to set sales count for ${type}:${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Delete sales count for a session or taxonomy
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   */
  async deleteSalesCount(
    type: 'session' | 'taxonomy',
    id: string,
  ): Promise<void> {
    try {
      const key = getSessionSalesCountKey(type, id);
      await this.redisConnection.del(key);

      this.logger.debug(`Deleted ${type} sales count: ${key}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to delete sales count for ${type}:${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get multiple sales counts in a single operation
   * @param type - 'session' or 'taxonomy'
   * @param ids - Array of session IDs or taxonomy term IDs
   * @returns Map of ID to count
   */
  async getBulkSalesCounts(
    type: 'session' | 'taxonomy',
    ids: string[],
  ): Promise<Map<string, number>> {
    try {
      if (ids.length === 0) {
        return new Map();
      }

      const keys = ids.map((id) => getSessionSalesCountKey(type, id));
      const values = await this.redisConnection.mget(...keys);

      const result = new Map<string, number>();
      ids.forEach((id, index) => {
        const count = values[index] ? parseInt(values[index], 10) : 0;
        result.set(id, count);
      });

      this.logger.debug(
        `Retrieved bulk ${type} sales counts for ${ids.length} items`,
      );

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to get bulk sales counts: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return new Map();
    }
  }

  /**
   * Check if a sales count key exists
   * @param type - 'session' or 'taxonomy'
   * @param id - The session ID or taxonomy term ID
   * @returns True if key exists, false otherwise
   */
  async salesCountExists(
    type: 'session' | 'taxonomy',
    id: string,
  ): Promise<boolean> {
    try {
      const key = getSessionSalesCountKey(type, id);
      const exists = await this.redisConnection.exists(key);

      return exists === 1;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to check if sales count exists for ${type}:${id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }
}

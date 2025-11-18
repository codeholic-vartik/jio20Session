/**
 * @fileoverview Session Publisher Service
 * @description Publishes sales and participant updates to Redis pub/sub channels
 * for real-time broadcasting to WebSocket clients
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import IORedis from 'ioredis';
import { getSessionSalesCountKey, REDIS_CHANNELS } from './session-redis.keys';

/**
 * Service for publishing session events to Redis pub/sub
 * These events are picked up by SessionRealtimeService and broadcast to WebSocket clients
 */
@Injectable()
export class SessionPublisherService {
  private readonly logger = new Logger(SessionPublisherService.name);

  constructor(
    @Inject('BULLMQ_CONNECTION') private readonly redisConnection: IORedis,
  ) {}

  /**
   * Publish sales count update for a session
   * This will trigger WebSocket broadcast to all connected clients
   *
   * @example
   * ```typescript
   * await publishSessionSalesUpdate(123, 45, 456);
   * // Broadcasts: session_id=123, count=45, session_profile_id=456
   * ```
   */
  async publishSessionSalesUpdate(
    sessionId: number,
    count: number,
    sessionProfileId?: number,
  ): Promise<void> {
    try {
      // Format matches: {"session_id":60,"session_profile_id":36,"count":1,"created_at":"2025-11-18T07:04:01.232Z"}
      const payload: {
        session_id: number;
        count: number;
        session_profile_id?: number;
        created_at: string;
      } = {
        session_id: sessionId,
        count,
        created_at: new Date().toISOString(),
      };

      // Include session_profile_id if provided
      if (sessionProfileId !== undefined) {
        payload.session_profile_id = sessionProfileId;
      }

      // Store in Redis key for persistence
      const key = getSessionSalesCountKey('session', sessionId.toString());
      await this.redisConnection.set(key, count.toString());

      // Publish to Redis pub/sub channel: session:sales:update
      await this.redisConnection.publish(
        REDIS_CHANNELS.SALES_UPDATE,
        JSON.stringify(payload),
      );

      this.logger.debug(
        `Published session sales update: session_id=${sessionId}, session_profile_id=${sessionProfileId || 'N/A'}, count=${count}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to publish session sales update: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Publish sales count update for a taxonomy term
   * This will trigger WebSocket broadcast to all connected clients
   *
   * @example
   * ```typescript
   * await publishTaxonomySalesUpdate('ttm_vt6ERZQiazfkM3P5822226', 100, 456);
   * // Broadcasts: taxonomy_term_id=ttm_vt6ERZQiazfkM3P5822226, count=100
   * ```
   */
  async publishTaxonomySalesUpdate(
    taxonomyTermId: string,
    count: number,
    sessionProfileId?: number,
  ): Promise<void> {
    try {
      const payload = {
        taxonomy_term_id: taxonomyTermId,
        count,
        ...(sessionProfileId && { session_profile_id: sessionProfileId }),
        type: 'taxonomy',
        created_at: new Date().toISOString(),
      };

      // Store in Redis key for persistence
      const key = getSessionSalesCountKey('taxonomy', taxonomyTermId);
      await this.redisConnection.set(key, count.toString());

      // Publish to Redis pub/sub channel
      await this.redisConnection.publish(
        REDIS_CHANNELS.TAXONOMY_SALES_UPDATE,
        JSON.stringify(payload),
      );

      this.logger.debug(
        `Published taxonomy sales update: taxonomy_term_id=${taxonomyTermId}, count=${count}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to publish taxonomy sales update: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Publish participant count update for a session
   * This will trigger WebSocket broadcast to all connected clients
   *
   * @example
   * ```typescript
   * await publishParticipantUpdate(
   *   'sess_abc123',
   *   1500,
   *   456,
   *   123,
   * );
   * ```
   */
  async publishParticipantUpdate(
    suid: string,
    participantCount: number,
    sessionProfileId: number,
    sessionId?: number,
    position?: number,
    isWinner?: boolean,
  ): Promise<void> {
    try {
      const payload = {
        suid,
        participant_count: participantCount,
        session_profile_id: sessionProfileId,
        ...(sessionId && { session_id: sessionId }),
        ...(position !== undefined && { position }),
        ...(isWinner !== undefined && { is_winner: isWinner }),
        created_at: new Date().toISOString(),
      };

      // Publish to Redis pub/sub channel using SUID-based channel
      const channel = `session:participant:${suid}`;
      await this.redisConnection.publish(channel, JSON.stringify(payload));

      this.logger.debug(
        `Published participant update: suid=${suid}, participant_count=${participantCount}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to publish participant update: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Increment and publish sales count for a session in a single operation
   * @returns The new count after increment
   */
  async incrementAndPublishSessionSales(
    sessionId: number,
    incrementBy: number = 1,
    sessionProfileId?: number,
  ): Promise<number> {
    try {
      // Increment in Redis
      const key = getSessionSalesCountKey('session', sessionId.toString());
      const newCount = await this.redisConnection.incrby(key, incrementBy);

      // Publish the update
      await this.publishSessionSalesUpdate(
        sessionId,
        newCount,
        sessionProfileId,
      );

      return newCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to increment and publish session sales: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Increment and publish sales count for a taxonomy term in a single operation
   * @returns The new count after increment
   */
  async incrementAndPublishTaxonomySales(
    taxonomyTermId: string,
    incrementBy: number = 1,
    sessionProfileId?: number,
  ): Promise<number> {
    try {
      // Increment in Redis
      const key = getSessionSalesCountKey('taxonomy', taxonomyTermId);
      const newCount = await this.redisConnection.incrby(key, incrementBy);

      // Publish the update
      await this.publishTaxonomySalesUpdate(
        taxonomyTermId,
        newCount,
        sessionProfileId,
      );

      return newCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to increment and publish taxonomy sales: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get current sales count without publishing
   */
  async getCurrentSalesCount(
    type: 'session' | 'taxonomy',
    id: string,
  ): Promise<number> {
    try {
      const key = getSessionSalesCountKey(type, id);
      const count = await this.redisConnection.get(key);
      return count ? parseInt(count, 10) : 0;
    } catch (error) {
      this.logger.error(
        `Failed to get sales count for ${type}:${id}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }
}

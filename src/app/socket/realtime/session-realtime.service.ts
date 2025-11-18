/**
 * @fileoverview Session Real-time Service
 * @description Subscribes to Redis pub/sub channels for real-time session updates
 * and broadcasts them to connected WebSocket clients via SocketGateway
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import IORedis, { RedisOptions } from 'ioredis';
import { normalizeRedisUrl } from '../../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../../common/utils/redis-db.util';
import { SocketGateway } from '../socket.gateway';
import {
  SalesCountUpdatePayload,
  ParticipantCountUpdatePayload,
} from './session-events.interface';
import { REDIS_CHANNELS } from './session-redis.keys';

/**
 * Service that subscribes to Redis pub/sub channels for real-time session updates.
 * Listens for:
 * - 'session:sales:update' - when sales count updates
 * - 'session:participant:*' - when participant count updates (pattern subscribe)
 * - 'taxonomy:sales:update' - when taxonomy sales count updates
 *
 * Broadcasts updates to connected WebSocket clients via SocketGateway.
 */
@Injectable()
export class SessionRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionRealtimeService.name);
  private subscriber: IORedis | null = null;
  private isInitialSubscription = true;

  constructor(
    @Inject(forwardRef(() => SocketGateway))
    private readonly socketGateway: SocketGateway,
  ) {}

  /**
   * Initialize Redis subscriber when the module starts
   */
  async onModuleInit(): Promise<void> {
    await this.connectAndSubscribe();
  }

  /**
   * Clean up Redis connection when the module is destroyed
   */
  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Disconnect from Redis and unsubscribe from all channels
   */
  private async disconnect(): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    try {
      await this.subscriber.unsubscribe(REDIS_CHANNELS.SALES_UPDATE);
      await this.subscriber.psubscribe(
        REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN,
      );
      await this.subscriber.unsubscribe(REDIS_CHANNELS.TAXONOMY_SALES_UPDATE);
      await this.subscriber.quit();
      this.subscriber = null;
      this.logger.log('Disconnected from Redis subscriber');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error during Redis disconnect: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Create Redis subscriber connection and subscribe to channels
   */
  private async connectAndSubscribe(): Promise<void> {
    try {
      const redisUrl = normalizeRedisUrl(
        process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || undefined,
      );

      const options = this.createRedisOptions(redisUrl);
      this.subscriber = new IORedis(redisUrl, options);

      this.setupConnectionEventHandlers();
      await this.waitForConnection();

      this.isInitialSubscription = false;

      await this.subscribeToChannels();
      this.setupMessageHandlers();

      this.logger.log(
        'Redis pub/sub subscriber initialized successfully - Listening for real-time events...',
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to initialize Redis subscriber: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Create Redis connection options with retry logic and TLS support
   */
  private createRedisOptions(redisUrl: string): RedisOptions {
    const wantsTls = this.shouldUseTls(redisUrl);
    const rejectUnauthorized =
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
    const dbIndex = resolveRedisDbIndex(redisUrl, {
      envNames: ['REDIS_BULLMQ_DB', 'REDIS_DB'],
    });

    this.logger.log(
      `Redis subscriber using database index: ${dbIndex} (REDIS_BULLMQ_DB=${process.env.REDIS_BULLMQ_DB || 'not set'}, REDIS_DB=${process.env.REDIS_DB || 'not set'})`,
    );

    return {
      ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
      db: dbIndex,
      retryStrategy: (times) => {
        const delay = Math.min(times * 200, 5000);
        this.logger.warn(
          `Redis subscriber connection failed, retrying in ${delay}ms (attempt ${times})`,
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

        if (
          reconnectErrors.some((errorType) => err.message.includes(errorType))
        ) {
          this.logger.warn(
            `Redis subscriber error detected (${err.message}), attempting reconnection...`,
          );
          return true;
        }

        return false;
      },
      enableReadyCheck: true,
      enableOfflineQueue: false, // Pub/sub doesn't queue messages
      connectTimeout: 10000,
      keepAlive: 30000,
      lazyConnect: false,
    };
  }

  /**
   * Determine if TLS should be used for Redis connection
   */
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
      // URL parsing failed, use default
    }

    return false;
  }

  /**
   * Setup connection event handlers for logging and re-subscription
   */
  private setupConnectionEventHandlers(): void {
    if (!this.subscriber) return;

    this.subscriber.on('connect', () => {
      this.logger.log('Redis subscriber connection established');
    });

    this.subscriber.on('ready', () => {
      this.logger.log('Redis subscriber connection ready');
      // Re-subscribe on reconnections, not initial connection
      if (!this.isInitialSubscription) {
        this.resubscribeToChannels();
      }
    });

    this.subscriber.on('close', () => {
      this.logger.warn(
        'Redis subscriber connection closed - will attempt to reconnect',
      );
    });

    this.subscriber.on('reconnecting', (delay: number) => {
      this.logger.warn(`Redis subscriber reconnecting in ${delay}ms...`);
    });

    this.subscriber.on('error', (error: Error) => {
      this.logger.error(
        `Redis subscriber error: ${error.message}`,
        error.stack,
      );
    });
  }

  /**
   * Wait for Redis connection to be ready
   */
  private async waitForConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            'Redis subscriber connection timeout - Redis may be unavailable',
          ),
        );
      }, 30000);

      if (this.subscriber?.status === 'ready') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      const onReady = () => {
        clearTimeout(timeout);
        this.subscriber?.removeListener('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timeout);
        this.subscriber?.removeListener('ready', onReady);
        reject(err);
      };

      this.subscriber?.once('ready', onReady);
      this.subscriber?.once('error', onError);
    });
  }

  /**
   * Subscribe to all Redis channels
   */
  private async subscribeToChannels(): Promise<void> {
    if (!this.subscriber) return;

    await this.subscriber.subscribe(REDIS_CHANNELS.SALES_UPDATE);
    this.logger.log(
      `Subscribed to Redis channel: ${REDIS_CHANNELS.SALES_UPDATE}`,
    );

    await this.subscriber.subscribe(REDIS_CHANNELS.TAXONOMY_SALES_UPDATE);
    this.logger.log(
      `Subscribed to Redis channel: ${REDIS_CHANNELS.TAXONOMY_SALES_UPDATE}`,
    );

    await this.subscriber.psubscribe(REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN);
    this.logger.log(
      `Subscribed to Redis pattern: ${REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN}`,
    );
  }

  /**
   * Re-subscribe to channels after reconnection
   */
  private resubscribeToChannels(): void {
    if (!this.subscriber) return;

    this.subscriber
      .subscribe(REDIS_CHANNELS.SALES_UPDATE)
      .then(() => {
        this.logger.log(
          `Re-subscribed to Redis channel: ${REDIS_CHANNELS.SALES_UPDATE}`,
        );
      })
      .catch((err) => {
        this.logger.error(
          `Failed to re-subscribe to channel: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    this.subscriber
      .subscribe(REDIS_CHANNELS.TAXONOMY_SALES_UPDATE)
      .then(() => {
        this.logger.log(
          `Re-subscribed to Redis channel: ${REDIS_CHANNELS.TAXONOMY_SALES_UPDATE}`,
        );
      })
      .catch((err) => {
        this.logger.error(
          `Failed to re-subscribe to channel: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    this.subscriber
      .psubscribe(REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN)
      .then(() => {
        this.logger.log(
          `Re-subscribed to Redis pattern: ${REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN}`,
        );
      })
      .catch((err) => {
        this.logger.error(
          `Failed to re-subscribe to pattern: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Setup message handlers for Redis pub/sub messages
   */
  private setupMessageHandlers(): void {
    if (!this.subscriber) return;

    // Handle regular channel messages
    this.subscriber.on('message', (channel: string, message: string) => {
      if (
        channel === REDIS_CHANNELS.SALES_UPDATE ||
        channel === REDIS_CHANNELS.TAXONOMY_SALES_UPDATE
      ) {
        try {
          this.handleSalesUpdate(message, channel);
        } catch (error) {
          this.logger.error(
            `Error handling sales update message: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    });

    // Handle pattern channel messages
    this.subscriber.on(
      'pmessage',
      (pattern: string, channel: string, message: string) => {
        if (pattern === REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN) {
          try {
            this.handleParticipantUpdate(message);
          } catch (error) {
            this.logger.error(
              `Error handling participant update message: ${error instanceof Error ? error.message : String(error)}`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        }
      },
    );
  }

  /**
   * Handle sales count update messages from Redis
   */
  private handleSalesUpdate(message: string, channel: string): void {
    try {
      const payload = this.parseAndValidateSalesPayload(message, channel);
      if (!payload) return;

      const { sessionId, sessionProfileId, taxonomyTermId, type } = payload;

      this.logger.log(
        `Received sales update: type=${type}, session_id=${sessionId || 'N/A'}, taxonomy_id=${taxonomyTermId || 'N/A'}, count=${payload.count}`,
      );

      // Broadcast based on type
      if (type === 'taxonomy' && taxonomyTermId !== null) {
        // For taxonomy sales, broadcast with taxonomy ID
        this.socketGateway.broadcastSalesCountUpdate(
          taxonomyTermId,
          payload.count,
          sessionProfileId || undefined,
        );
      } else if (sessionId !== null) {
        // For session sales, broadcast with session ID
        this.socketGateway.broadcastSalesCountUpdate(
          sessionId,
          payload.count,
          sessionProfileId || undefined,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to process sales update message: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Handle participant count update messages from Redis
   */
  private handleParticipantUpdate(message: string): void {
    try {
      const payload = this.parseAndValidateParticipantPayload(message);
      if (!payload) return;

      const { suid, participantCount, sessionProfileId, sessionId } = payload;

      this.logger.log(
        `Received participant update: suid=${suid}, session_profile_id=${sessionProfileId}, participant_count=${participantCount}`,
      );

      this.socketGateway.broadcastParticipantUpdate(
        suid,
        participantCount,
        sessionProfileId,
        sessionId || undefined,
        payload.position,
        payload.isWinner,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to process participant update message: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Parse and validate sales update payload
   */
  private parseAndValidateSalesPayload(
    message: string,
    channel: string,
  ): {
    count: number;
    sessionId: number | null;
    sessionProfileId: number | null;
    taxonomyTermId: number | null;
    type: 'session' | 'taxonomy';
  } | null {
    if (!this.isValidJsonMessage(message, channel)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.trim());
    } catch {
      this.logger.warn(
        `Failed to parse JSON message on channel ${channel}: "${message.substring(0, 100)}"`,
      );
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || !('count' in parsed)) {
      this.logger.warn(
        `Invalid sales update payload structure: ${JSON.stringify(Object.keys(parsed || {}))}`,
      );
      return null;
    }

    const payload = parsed as SalesCountUpdatePayload;
    const type =
      channel === REDIS_CHANNELS.TAXONOMY_SALES_UPDATE
        ? 'taxonomy'
        : payload.type || 'session';

    const sessionId =
      payload.session_id !== undefined
        ? this.parseNumericId(payload.session_id, 'sess_')
        : null;
    const sessionProfileId =
      payload.session_profile_id !== undefined
        ? this.parseNumericId(payload.session_profile_id, 'prod_')
        : null;
    const taxonomyTermId =
      payload.taxonomy_term_id !== undefined
        ? this.parseNumericId(payload.taxonomy_term_id, 'tax_')
        : null;

    return {
      count: payload.count,
      sessionId,
      sessionProfileId,
      taxonomyTermId,
      type,
    };
  }

  /**
   * Parse and validate participant update payload
   */
  private parseAndValidateParticipantPayload(message: string): {
    suid: string;
    participantCount: number;
    sessionProfileId: number;
    sessionId: number | null;
    position?: number;
    isWinner?: boolean;
  } | null {
    if (
      !this.isValidJsonMessage(
        message,
        REDIS_CHANNELS.PARTICIPANT_UPDATE_PATTERN,
      )
    ) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.trim());
    } catch {
      this.logger.warn(
        `Failed to parse JSON message: "${message.substring(0, 100)}"`,
      );
      return null;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('session_profile_id' in parsed) ||
      !('participant_count' in parsed) ||
      !('suid' in parsed)
    ) {
      this.logger.warn(
        `Invalid participant update payload structure: ${JSON.stringify(Object.keys(parsed || {}))}`,
      );
      return null;
    }

    const payload = parsed as ParticipantCountUpdatePayload;
    const sessionProfileId = this.parseNumericId(
      payload.session_profile_id,
      'prod_',
    );

    if (sessionProfileId === null) {
      this.logger.warn(
        `Failed to parse session_profile_id: ${payload.session_profile_id}`,
      );
      return null;
    }

    const sessionId =
      payload.session_id !== undefined
        ? this.parseNumericId(payload.session_id, 'sess_')
        : null;

    return {
      suid: payload.suid,
      participantCount: payload.participant_count,
      sessionProfileId,
      sessionId,
      position: payload.position,
      isWinner: payload.is_winner,
    };
  }

  /**
   * Validate that message is non-empty JSON
   */
  private isValidJsonMessage(message: string, context: string): boolean {
    if (
      !message ||
      typeof message !== 'string' ||
      message.trim().length === 0
    ) {
      this.logger.warn(`Received empty or invalid message on ${context}`);
      return false;
    }

    const trimmed = message.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      this.logger.warn(
        `Received non-JSON message on ${context}: "${message.substring(0, 50)}"`,
      );
      return false;
    }

    return true;
  }

  /**
   * Parse numeric ID from string or number
   */
  private parseNumericId(id: string | number, prefix?: string): number | null {
    if (typeof id === 'number') {
      return id;
    }

    if (!id || typeof id !== 'string') {
      return null;
    }

    // Try plain number first
    const plainNumber = parseInt(id, 10);
    if (!isNaN(plainNumber)) {
      return plainNumber;
    }

    // Try removing prefix
    if (prefix && id.startsWith(prefix)) {
      const idWithoutPrefix = id.slice(prefix.length);
      const prefixedNumber = parseInt(idWithoutPrefix, 10);
      if (!isNaN(prefixedNumber)) {
        return prefixedNumber;
      }
    }

    return null;
  }
}

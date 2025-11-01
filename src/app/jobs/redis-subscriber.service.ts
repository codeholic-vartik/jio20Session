import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import IORedis, { RedisOptions } from 'ioredis';
import { Queue } from 'bullmq';
import { SessionService } from '../session/session.service';

const THRESHOLD_REACHED_CHANNEL = 'session:sales:threshold_reached';

/**
 * Payload structure for threshold reached events from Redis pub/sub
 */
interface ThresholdReachedPayload {
  session_id: number | string;
  count: number;
  session_profile_id: number | string;
  created_at?: string;
}

/**
 * Service that subscribes to Redis pub/sub channel for threshold reached events.
 * Listens for messages on 'session:sales:threshold_reached' and queues jobs for processing.
 */
@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: IORedis | null = null;

  constructor(
    @Inject('BULLMQ_CONNECTION') private readonly redisConnection: IORedis,
    @Inject('SESSION_QUEUE') private readonly sessionQueue: Queue,
    private readonly sessionService: SessionService,
  ) {
    // Ensure sessionService is properly initialized
    if (!this.sessionService) {
      throw new Error('SessionService is required');
    }
  }

  /**
   * Initialize the Redis subscriber when the module starts
   */
  async onModuleInit() {
    await this.connectAndSubscribe();
  }

  /**
   * Clean up Redis connection when the module is destroyed
   */
  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(THRESHOLD_REACHED_CHANNEL);
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  /**
   * Creates a Redis subscriber connection and subscribes to the threshold reached channel.
   * Sets up message handlers and error handlers for the pub/sub connection.
   * Uses the same Redis connection configuration as BullmqModule.
   */
  private async connectAndSubscribe() {
    try {
      // Create a dedicated subscriber client (Redis requires separate connection for pub/sub)
      const redisUrl =
        process.env.REDIS_BULLMQ_URL ||
        process.env.REDIS_URL ||
        'redis://127.0.0.1:6379';

      // Reuse the same connection logic as BullmqModule
      const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();
      let wantsTls: boolean | null = null;
      if (['true', '1', 'yes'].includes(tlsFlag)) wantsTls = true;
      if (['false', '0', 'no'].includes(tlsFlag)) wantsTls = false;
      if (wantsTls === null) {
        try {
          const u = new URL(redisUrl);
          if (u.protocol === 'rediss:') wantsTls = true;
          const sslParam =
            u.searchParams.get('ssl') || u.searchParams.get('tls');
          if (wantsTls === null && sslParam && /^(1|true|yes)$/i.test(sslParam))
            wantsTls = true;
        } catch {
          // URL parsing failed, continue with default
        }
        if (wantsTls === null) wantsTls = false;
      }
      const rejectUnauthorized =
        process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';

      let dbIndex: number | undefined = undefined;
      const envDb = process.env.REDIS_DB;
      if (envDb && /^\d+$/.test(envDb)) dbIndex = Number(envDb);
      if (dbIndex === undefined) {
        try {
          const u = new URL(redisUrl);
          const pathDb =
            u.pathname && u.pathname.length > 1
              ? Number(u.pathname.slice(1))
              : NaN;
          if (!Number.isNaN(pathDb)) dbIndex = pathDb;
          const qpDb = u.searchParams.get('db');
          if (dbIndex === undefined && qpDb && /^\d+$/.test(qpDb))
            dbIndex = Number(qpDb);
        } catch {
          // URL parsing failed, continue with default
        }
      }
      if (dbIndex === undefined) dbIndex = 0;

      const options: RedisOptions = {
        ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
        db: dbIndex,
      };
      this.subscriber = new IORedis(redisUrl, options);

      // Subscribe to the channel
      await this.subscriber.subscribe(THRESHOLD_REACHED_CHANNEL);
      this.logger.log(
        `Subscribed to Redis channel: ${THRESHOLD_REACHED_CHANNEL}`,
      );

      // Listen for messages
      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === THRESHOLD_REACHED_CHANNEL) {
          // Fire and forget - handle errors internally
          this.handleThresholdReached(message).catch((error) => {
            this.logger.error(
              `Error handling threshold reached message: ${error instanceof Error ? error.message : String(error)}`,
              error instanceof Error ? error.stack : undefined,
            );
          });
        }
      });

      // Handle subscription errors
      this.subscriber.on('error', (error: Error) => {
        this.logger.error(
          `Redis subscriber error: ${error.message}`,
          error.stack,
        );
      });

      this.logger.log(
        'Redis pub/sub subscriber initialized successfully - Listening for events...',
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to initialize Redis subscriber: ${errorMessage}`,
        errorStack,
      );
      throw error;
    }
  }

  /**
   * Creates a session when threshold is reached.
   * Handles errors gracefully and logs the result.
   *
   * @param sessionId - The session ID that reached threshold
   * @param sessionProfileId - The session profile ID associated with the session
   * @returns Promise that resolves when session creation completes (or fails gracefully)
   */
  private async createSessionOnThreshold(
    sessionId: number,
    sessionProfileId: number,
  ): Promise<void> {
    const service = this.sessionService as SessionService & {
      createSession: (
        sessionId: number,
        sessionProfileId: number,
      ) => Promise<{
        success: boolean;
        message: string;
        newSessionId?: number;
      }>;
    };

    if (!service || typeof service.createSession !== 'function') {
      this.logger.error('SessionService.createSession is not available');
      return;
    }

    try {
      const result = await service.createSession(sessionId, sessionProfileId);

      // Validate result structure before accessing properties
      if (
        result &&
        typeof result === 'object' &&
        'message' in result &&
        typeof result.message === 'string'
      ) {
        this.logger.log(`Session creation result: ${result.message}`);
      } else {
        this.logger.warn('Session creation returned unexpected result format');
      }
    } catch (sessionError) {
      const errorMessage =
        sessionError instanceof Error
          ? sessionError.message
          : String(sessionError);
      this.logger.error(`${errorMessage}`);
      // Continue execution even if session creation fails
    }
  }

  /**
   * Handles incoming threshold reached messages from Redis pub/sub.
   * Validates the message format, parses JSON, extracts IDs, and queues a job.
   *
   * @param message - The raw message string from Redis pub/sub
   */
  private async handleThresholdReached(message: string) {
    try {
      // Validate message is not empty and looks like JSON
      if (
        !message ||
        typeof message !== 'string' ||
        message.trim().length === 0
      ) {
        this.logger.warn(
          `Received empty or invalid message on channel ${THRESHOLD_REACHED_CHANNEL}`,
        );
        return;
      }

      // Check if message looks like JSON (starts with { or [)
      const trimmedMessage = message.trim();
      if (!trimmedMessage.startsWith('{') && !trimmedMessage.startsWith('[')) {
        this.logger.warn(
          `Received non-JSON message on channel ${THRESHOLD_REACHED_CHANNEL}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`,
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedMessage);
      } catch {
        this.logger.warn(
          `Failed to parse JSON message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
        );
        return;
      }

      // Validate payload structure
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('session_profile_id' in parsed) ||
        !('session_id' in parsed)
      ) {
        this.logger.warn(
          `Invalid payload structure. Expected session_profile_id and session_id, got: ${JSON.stringify(Object.keys(parsed || {}))}`,
        );
        return;
      }
      const payload = parsed as ThresholdReachedPayload;

      // Extract numeric IDs - handle both number and string formats
      const sessionId =
        typeof payload.session_id === 'number'
          ? payload.session_id
          : this.parseNumericId(String(payload.session_id), 'sess_');
      const sessionProfileId =
        typeof payload.session_profile_id === 'number'
          ? payload.session_profile_id
          : this.parseNumericId(String(payload.session_profile_id), 'prod_');

      if (sessionId === null || sessionProfileId === null) {
        this.logger.warn(
          `Failed to parse IDs from payload: session_id=${payload.session_id}, session_profile_id=${payload.session_profile_id}`,
        );
        return;
      }

      // Log count if present (for monitoring/debugging)
      if (payload.count !== undefined) {
        this.logger.debug(
          `Threshold reached with count: ${payload.count} for session ${sessionId}`,
        );
      }

      this.logger.log(
        `Received threshold reached event: session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
      );

      // Create session when threshold is reached
      await this.createSessionOnThreshold(sessionId, sessionProfileId);

      //   // Add job to the session queue
      //   await this.sessionQueue.add(
      //     'threshold-reached',
      //     {
      //       sessionId,
      //       sessionProfileId,
      //     },
      //     {
      //       attempts: 3,
      //       backoff: {
      //         type: 'exponential',
      //         delay: 2000,
      //       },
      //     },
      //   );

      this.logger.log(
        `Queued threshold-reached job: session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to process threshold reached message: ${errorMessage}`,
        errorStack,
      );
    }
  }

  /**
   * Parses numeric ID from a string, handling both prefixed and plain formats.
   * Examples: "prod_123" -> 123, "123" -> 123, "sess_456" -> 456, "456" -> 456
   *
   * @param idStr - The ID string (may have prefix like "prod_123" or plain "123")
   * @param prefix - Optional prefix to remove if present (e.g., "prod_", "sess_")
   * @returns The numeric ID, or null if invalid format
   */
  private parseNumericId(idStr: string, prefix?: string): number | null {
    if (!idStr || typeof idStr !== 'string') {
      return null;
    }

    // Try to parse as plain number first
    const plainNumber = parseInt(idStr, 10);
    if (!isNaN(plainNumber)) {
      return plainNumber;
    }

    // If plain number parsing failed and prefix provided, try removing prefix
    if (prefix && idStr.startsWith(prefix)) {
      const idWithoutPrefix = idStr.slice(prefix.length);
      const prefixedNumber = parseInt(idWithoutPrefix, 10);
      if (!isNaN(prefixedNumber)) {
        return prefixedNumber;
      }
    }

    return null;
  }
}

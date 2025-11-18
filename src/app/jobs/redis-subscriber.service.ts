import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import IORedis, { RedisOptions } from 'ioredis';
import { Queue } from 'bullmq';
import { SessionService } from '../session/session.service';
import { SocketGateway } from '../socket/socket.gateway';
import { normalizeRedisUrl } from '../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../common/utils/redis-db.util';

// TODO  HAVE TO KEPP IN ENV FILES
const THRESHOLD_REACHED_CHANNEL = 'session:sales:threshold_reached';
const SALES_UPDATE_CHANNEL = 'session:sales:update';
const PARTICIPANT_UPDATE_PATTERN = 'session:participant:*';

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
 * Payload structure for participant update events from Redis pub/sub
 */
interface ParticipantUpdatePayload {
  suid: string;
  participant_count: number;
  session_profile_id: number;
  session_id?: number;
  position?: number;
  is_winner?: boolean;
  created_at?: string;
}

/**
 * Payload structure for sales update events from Redis pub/sub
 */
interface SalesUpdatePayload {
  session_id: number | string;
  count: number;
  session_profile_id: number | string;
  created_at?: string;
}

/**
 * Service that subscribes to Redis pub/sub channels for real-time updates.
 * Listens for:
 * - 'session:sales:threshold_reached' - when sales threshold is reached
 * - 'session:sales:update' - when sales count updates
 * - 'session:participant:*' - when participant count updates (pattern subscribe)
 *
 * Broadcasts updates to connected WebSocket clients via SocketGateway.
 */
@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: IORedis | null = null;
  private salesStorageConnection: IORedis | null = null;

  constructor(
    @Inject('BULLMQ_CONNECTION') private readonly redisConnection: IORedis,
    @Inject('SESSION_QUEUE') private readonly sessionQueue: Queue,
    private readonly sessionService: SessionService,
    @Inject(forwardRef(() => SocketGateway))
    private readonly socketGateway: SocketGateway,
  ) {
    // Ensure sessionService is properly initialized
    if (!this.sessionService) {
      throw new Error('SessionService is required');
    }

    // Log which Redis database the BULLMQ_CONNECTION is using
    const dbIndex =
      this.redisConnection.options?.db !== undefined
        ? this.redisConnection.options.db
        : 'unknown';
    this.logger.log(
      `RedisSubscriberService initialized - BULLMQ_CONNECTION using Redis DB index: ${dbIndex}`,
    );
  }

  /**
   * Initialize the Redis subscriber when the module starts
   */
  async onModuleInit() {
    this.createSalesStorageConnection();
    await this.connectAndSubscribe();
  }

  /**
   * Clean up Redis connection when the module is destroyed
   */
  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(THRESHOLD_REACHED_CHANNEL);
      await this.subscriber.unsubscribe(SALES_UPDATE_CHANNEL);
      await this.subscriber.unsubscribe(PARTICIPANT_UPDATE_PATTERN);
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.salesStorageConnection) {
      await this.salesStorageConnection.quit();
      this.salesStorageConnection = null;
    }
  }

  /**
   * Creates a Redis subscriber connection and subscribes to the threshold reached channel.
   * Sets up message handlers and error handlers for the pub/sub connection.
   * Uses the same Redis connection configuration as BullmqModule.
   */
  /**
   * Creates a separate Redis connection for storing sales data
   * Uses REDIS_DB (not REDIS_BULLMQ_DB) to match where sync worker reads from
   */
  private createSalesStorageConnection() {
    try {
      const redisUrl = normalizeRedisUrl(
        process.env.REDIS_URL || process.env.REDIS_BULLMQ_URL || undefined,
      );

      // Use REDIS_DB only (not REDIS_BULLMQ_DB) to match where sync worker reads from
      const dbIndex = resolveRedisDbIndex(redisUrl || '', {
        envNames: ['REDIS_DB'], // Only use REDIS_DB, not REDIS_BULLMQ_DB
      });

      this.logger.log(
        `Creating Redis connection for sales storage with database index: ${dbIndex} (resolved from REDIS_DB=${process.env.REDIS_DB || 'not set'})`,
      );

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

      const options: RedisOptions = {
        ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
        db: dbIndex,
        retryStrategy: (times) => {
          const delay = Math.min(times * 200, 5000);
          this.logger.warn(
            `Sales storage Redis connection failed, retrying in ${delay}ms (attempt ${times})`,
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
              `Sales storage Redis error detected (${err.message}), attempting reconnection...`,
            );
            return true;
          }
          return false;
        },
        enableReadyCheck: true,
        lazyConnect: false,
        enableOfflineQueue: true,
        connectTimeout: 10000,
        keepAlive: 30000,
      };

      this.salesStorageConnection = new IORedis(redisUrl, options);

      this.salesStorageConnection.on('error', (err) => {
        this.logger.error(
          `Sales storage Redis connection error: ${err.message}`,
        );
      });

      this.salesStorageConnection.on('connect', () => {
        this.logger.log('Sales storage Redis connection established');
      });

      this.salesStorageConnection.on('ready', () => {
        this.logger.log('Sales storage Redis connection ready and operational');
      });

      this.salesStorageConnection.on('close', () => {
        this.logger.warn(
          'Sales storage Redis connection closed - will attempt to reconnect',
        );
      });

      this.salesStorageConnection.on('reconnecting', (delay: number) => {
        this.logger.warn(`Sales storage Redis reconnecting in ${delay}ms...`);
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to create sales storage Redis connection: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  private async connectAndSubscribe() {
    try {
      // Create a dedicated subscriber client (Redis requires separate connection for pub/sub)
      const redisUrl = normalizeRedisUrl(
        process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || undefined,
      );

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

      const dbIndex = resolveRedisDbIndex(redisUrl, {
        envNames: ['REDIS_BULLMQ_DB', 'REDIS_DB'],
      });

      this.logger.log(
        `Redis subscriber will use database index: ${dbIndex} (resolved from REDIS_BULLMQ_DB=${process.env.REDIS_BULLMQ_DB || 'not set'}, REDIS_DB=${process.env.REDIS_DB || 'not set'})`,
      );

      const options: RedisOptions = {
        ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
        db: dbIndex,
        retryStrategy: (times) => {
          // Retry indefinitely with exponential backoff
          const delay = Math.min(times * 200, 5000); // Max 5 seconds between retries
          this.logger.warn(
            `Redis subscriber connection failed, retrying in ${delay}ms (attempt ${times})`,
          );
          return delay; // Keep retrying - never return null
        },
        reconnectOnError: (err) => {
          // Reconnect on any connection-related errors
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
              `Redis subscriber error detected (${err.message}), attempting reconnection...`,
            );
            return true;
          }

          return false;
        },
        enableReadyCheck: true,
        enableOfflineQueue: false, // Pub/sub doesn't queue messages
        connectTimeout: 10000, // 10 second connection timeout
        keepAlive: 30000, // Send keepalive every 30 seconds
        lazyConnect: false, // Connect immediately
      };
      this.subscriber = new IORedis(redisUrl, options);
      let isInitialSubscription = true; // Track if this is the first subscription

      // Handle connection events
      this.subscriber.on('connect', () => {
        this.logger.log('Redis subscriber connection established');
      });

      // Set up re-subscription handler for reconnections (not initial connection)
      this.subscriber.on('ready', () => {
        this.logger.log('Redis subscriber connection ready');
        // Only re-subscribe on reconnections, not initial connection
        if (!isInitialSubscription) {
          this.subscriber
            ?.subscribe(THRESHOLD_REACHED_CHANNEL)
            .then(() => {
              this.logger.log(
                `Re-subscribed to Redis channel: ${THRESHOLD_REACHED_CHANNEL}`,
              );
            })
            .catch((err) => {
              this.logger.error(
                `Failed to re-subscribe to channel: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          this.subscriber
            ?.subscribe(SALES_UPDATE_CHANNEL)
            .then(() => {
              this.logger.log(
                `Re-subscribed to Redis channel: ${SALES_UPDATE_CHANNEL}`,
              );
            })
            .catch((err) => {
              this.logger.error(
                `Failed to re-subscribe to channel: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          this.subscriber
            ?.psubscribe(PARTICIPANT_UPDATE_PATTERN)
            .then(() => {
              this.logger.log(
                `Re-subscribed to Redis pattern: ${PARTICIPANT_UPDATE_PATTERN}`,
              );
            })
            .catch((err) => {
              this.logger.error(
                `Failed to re-subscribe to pattern: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      });

      // Wait for connection to be ready before initial subscribe
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              'Redis subscriber connection timeout - Redis may be unavailable',
            ),
          );
        }, 30000); // 30 second timeout

        // Check if already ready
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

      // Now that connection is ready, do initial subscription
      isInitialSubscription = false;

      this.subscriber.on('close', () => {
        this.logger.warn(
          'Redis subscriber connection closed - will attempt to reconnect',
        );
      });

      this.subscriber.on('reconnecting', (delay: number) => {
        this.logger.warn(`Redis subscriber reconnecting in ${delay}ms...`);
      });

      // Subscribe to the channel (connection is now ready)
      await this.subscriber.subscribe(THRESHOLD_REACHED_CHANNEL);
      await this.subscriber.subscribe(SALES_UPDATE_CHANNEL);
      await this.subscriber.psubscribe(PARTICIPANT_UPDATE_PATTERN);
      this.logger.log(
        `Subscribed to Redis channel: ${THRESHOLD_REACHED_CHANNEL}`,
      );
      this.logger.log(`Subscribed to Redis channel: ${SALES_UPDATE_CHANNEL}`);
      this.logger.log(
        `Subscribed to Redis pattern: ${PARTICIPANT_UPDATE_PATTERN}`,
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
        } else if (channel === SALES_UPDATE_CHANNEL) {
          // Fire and forget - handle errors internally
          this.handleSalesUpdate(message).catch((error) => {
            this.logger.error(
              `Error handling sales update message: ${error instanceof Error ? error.message : String(error)}`,
              error instanceof Error ? error.stack : undefined,
            );
          });
        }
      });

      this.subscriber.on(
        'pmessage',
        (pattern: string, channel: string, message: string) => {
          if (pattern === PARTICIPANT_UPDATE_PATTERN) {
            this.handleParticipantUpdate(message);
          }
        },
      );

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

      // If max sessions limit reached, disable sales before continuing
      if (errorMessage.includes('Maximum sessions limit reached')) {
        this.logger.log(
          `Max sessions limit reached. Disabling sales for profile ${sessionProfileId}`,
        );
        try {
          await this.sessionService.disableSalesForProfile(sessionProfileId);
        } catch (disableError) {
          this.logger.error(
            `Failed to disable sales after max sessions limit: ${disableError instanceof Error ? disableError.message : String(disableError)}`,
          );
        }
      }

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
   * Handles incoming sales update messages from Redis pub/sub.
   * Validates the message format, parses JSON, and broadcasts to WebSocket clients.
   *
   * @param message - The raw message string from Redis pub/sub
   */
  private async handleSalesUpdate(message: string) {
    try {
      if (
        !message ||
        typeof message !== 'string' ||
        message.trim().length === 0
      ) {
        this.logger.warn(
          `Received empty or invalid message on channel ${SALES_UPDATE_CHANNEL}`,
        );
        return;
      }

      const trimmedMessage = message.trim();
      if (!trimmedMessage.startsWith('{') && !trimmedMessage.startsWith('[')) {
        this.logger.warn(
          `Received non-JSON message on channel ${SALES_UPDATE_CHANNEL}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`,
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedMessage);
      } catch {
        this.logger.warn(
          `Failed to parse JSON message on channel ${SALES_UPDATE_CHANNEL}: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
        );
        return;
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('session_profile_id' in parsed) ||
        !('session_id' in parsed) ||
        !('count' in parsed)
      ) {
        this.logger.warn(
          `Invalid payload structure for sales update: ${JSON.stringify(Object.keys(parsed || {}))}`,
        );
        return;
      }

      const payload = parsed as SalesUpdatePayload;
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
          `Failed to parse IDs from sales update payload: session_id=${payload.session_id}, session_profile_id=${payload.session_profile_id}`,
        );
        return;
      }

      this.logger.log(
        `Received sales update event: session_id=${sessionId}, session_profile_id=${sessionProfileId}, count=${payload.count}`,
      );

      // Store the sales count in Redis key for sync job to pick up
      // This key is what the sync-sales job scans for
      // Use salesStorageConnection (REDIS_DB) instead of redisConnection (BULLMQ_CONNECTION)
      const salesRedisKey = `session:sales:${sessionId}`;
      if (!this.salesStorageConnection) {
        this.logger.error(
          'Sales storage connection not initialized - cannot store sales count',
        );
        return;
      }

      try {
        // Get the database index BEFORE storing for logging
        const dbIndex =
          this.salesStorageConnection.options?.db !== undefined
            ? this.salesStorageConnection.options.db
            : 'unknown';

        // Set the count directly (the count from payload is already cumulative)
        // Use SET instead of INCR because the payload contains the total count
        await this.salesStorageConnection.set(
          salesRedisKey,
          payload.count.toString(),
        );

        // Verify the value was stored correctly
        const storedValue =
          await this.salesStorageConnection.get(salesRedisKey);
        this.logger.log(
          `Stored sales count in Redis: ${salesRedisKey}=${payload.count} (Redis DB index: ${dbIndex}, verified: ${storedValue})`,
        );
      } catch (redisError) {
        // Log error but don't fail - WebSocket broadcast should still work
        const errorMessage =
          redisError instanceof Error ? redisError.message : String(redisError);
        this.logger.error(
          `Failed to store sales count in Redis key ${salesRedisKey}: ${errorMessage}`,
          redisError instanceof Error ? redisError.stack : undefined,
        );
      }

      this.socketGateway.broadcastSalesCountUpdate(
        sessionId,
        payload.count,
        sessionProfileId,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to process sales update message: ${errorMessage}`,
        errorStack,
      );
    }
  }

  /**
   * Handles incoming participant update messages from Redis pub/sub.
   * Validates the message format, parses JSON, and broadcasts to WebSocket clients.
   *
   * @param message - The raw message string from Redis pub/sub
   */
  private handleParticipantUpdate(message: string) {
    try {
      if (
        !message ||
        typeof message !== 'string' ||
        message.trim().length === 0
      ) {
        this.logger.warn(
          `Received empty or invalid message on pattern ${PARTICIPANT_UPDATE_PATTERN}`,
        );
        return;
      }

      const trimmedMessage = message.trim();
      if (!trimmedMessage.startsWith('{') && !trimmedMessage.startsWith('[')) {
        this.logger.warn(
          `Received non-JSON message on pattern ${PARTICIPANT_UPDATE_PATTERN}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`,
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedMessage);
      } catch {
        this.logger.warn(
          `Failed to parse JSON message on pattern ${PARTICIPANT_UPDATE_PATTERN}: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
        );
        return;
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('session_profile_id' in parsed) ||
        !('participant_count' in parsed)
      ) {
        this.logger.warn(
          `Invalid payload structure for participant update: ${JSON.stringify(Object.keys(parsed || {}))}`,
        );
        return;
      }

      const payload = parsed as ParticipantUpdatePayload;

      if (!payload.suid) {
        this.logger.warn(
          `Missing suid in participant update payload: ${JSON.stringify(payload)}`,
        );
        return;
      }

      const sessionProfileId =
        typeof payload.session_profile_id === 'number'
          ? payload.session_profile_id
          : this.parseNumericId(String(payload.session_profile_id), 'prod_');

      if (sessionProfileId === null) {
        this.logger.warn(
          `Failed to parse session_profile_id from participant update payload: session_profile_id=${payload.session_profile_id}`,
        );
        return;
      }

      const sessionId =
        payload.session_id !== undefined
          ? typeof payload.session_id === 'number'
            ? payload.session_id
            : this.parseNumericId(String(payload.session_id), 'sess_')
          : null;

      this.logger.log(
        `Received participant update event: suid=${payload.suid}, session_profile_id=${sessionProfileId}, participant_count=${payload.participant_count}`,
      );

      this.socketGateway.broadcastParticipantUpdate(
        payload.suid,
        payload.participant_count,
        sessionProfileId,
        sessionId || undefined,
        payload.position,
        payload.is_winner,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to process participant update message: ${errorMessage}`,
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

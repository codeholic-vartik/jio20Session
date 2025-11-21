import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import { Server, ServerOptions } from 'socket.io';
import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../common/logger/logger.util';
import { normalizeRedisUrl } from '../../common/utils/redis-url.util';
import { resolveRedisDbIndex } from '../../common/utils/redis-db.util';

const logger: StandaloneLogger = createStandaloneLogger('RedisIoAdapter');

export class RedisIoAdapter extends IoAdapter {
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  private redisUrl: string;

  constructor(
    private app: INestApplicationContext,
    redisUrl: string,
  ) {
    super(app);
    this.redisUrl = normalizeRedisUrl(redisUrl);
  }

  async connectToRedis(): Promise<void> {
    // Authoritative REDIS_TLS flag: if set truthy => TLS, if falsy => plain. If unset => infer.
    const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();
    let wantsTls: boolean | null = null;
    if (['true', '1', 'yes'].includes(tlsFlag)) wantsTls = true;
    if (['false', '0', 'no'].includes(tlsFlag)) wantsTls = false;
    if (wantsTls === null) {
      try {
        const u = new URL(this.redisUrl);
        if (u.protocol === 'rediss:') wantsTls = true;
        const sslParam = u.searchParams.get('ssl') || u.searchParams.get('tls');
        if (wantsTls === null && sslParam && /^(1|true|yes)$/i.test(sslParam))
          wantsTls = true;
      } catch {
        // URL parsing failed, continue with default
      }
      if (wantsTls === null) wantsTls = false;
    }
    const rejectUnauthorized =
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
    // Determine DB index: env overrides URL; default 0
    const dbIndex = resolveRedisDbIndex(this.redisUrl);
    const redisOptions: RedisOptions = {
      ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
      db: dbIndex,
      retryStrategy: (times) => {
        // Retry indefinitely with exponential backoff
        const delay = Math.min(times * 200, 5000); // Max 5 seconds between retries
        logger.warn(
          `Redis IO adapter connection failed, retrying in ${delay}ms (attempt ${times})`,
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
          logger.warn(
            `Redis IO adapter error detected (${err.message}), attempting reconnection...`,
          );
          return true;
        }

        return false;
      },
      enableReadyCheck: true,
      connectTimeout: 10000, // 10 second connection timeout
      keepAlive: 30000, // Send keepalive every 30 seconds
    };
    const pubClient = new Redis(this.redisUrl, redisOptions);
    const subClient = new Redis(this.redisUrl, redisOptions);

    this.pubClient = pubClient;
    this.subClient = subClient;

    // Set up connection event handlers for pub client
    pubClient.on('error', (err) => {
      logger.error(`Redis pub client error: ${err.message}`);
    });

    pubClient.on('connect', () => {
      logger.log('Redis pub client connection established');
    });

    pubClient.on('ready', () => {
      logger.log('Redis pub client connection ready');
    });

    pubClient.on('close', () => {
      logger.warn(
        'Redis pub client connection closed - will attempt to reconnect',
      );
    });

    // Set up connection event handlers for sub client
    subClient.on('error', (err) => {
      logger.error(`Redis sub client error: ${err.message}`);
    });

    subClient.on('connect', () => {
      logger.log('Redis sub client connection established');
    });

    subClient.on('ready', () => {
      logger.log('Redis sub client connection ready');
    });

    subClient.on('close', () => {
      logger.warn(
        'Redis sub client connection closed - will attempt to reconnect',
      );
    });

    // Enforce or warn about eviction policy (on publisher client only)
    try {
      if (this.pubClient) {
        // Use Redis client's config method with proper typing
        const cfg = await this.pubClient.config('GET', 'maxmemory-policy');
        const current =
          Array.isArray(cfg) && cfg.length > 1 ? (cfg[1] as string) : undefined;
        if (process.env.REDIS_ENFORCE_NOEVICTION === 'true') {
          if (current !== 'noeviction') {
            await this.pubClient.config(
              'SET',
              'maxmemory-policy',
              'noeviction',
            );
          }
        } else if (current && current !== 'noeviction') {
          logger.warn(
            `IMPORTANT! Eviction policy is ${current}. It should be "noeviction"`,
          );
        }
      }
    } catch {
      // Redis config command failed, skip policy check
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    // Optimized Socket.IO options for high concurrency (100k+ users)
    const opts: ServerOptions = {
      cors: { origin: true, credentials: true },
      transports: ['polling', 'websocket'],
      // Connection timeout: 45 seconds (increase for slow networks)
      connectTimeout: 45000,
      // Ping interval: 25 seconds (balance between detection and overhead)
      pingInterval: 25000,
      // Ping timeout: 20 seconds (client must respond within this time)
      pingTimeout: 20000,
      // Upgrade timeout: 10 seconds (time to upgrade from polling to websocket)
      upgradeTimeout: 10000,
      // Max HTTP buffer size: 1MB (prevent DoS via large payloads)
      maxHttpBufferSize: 1e6,
      // Allow Engine.IO v3 clients (backward compatibility)
      allowEIO3: true,
      // Per-message deflate compression (reduce bandwidth, slight CPU cost)
      // Enable only if bandwidth is more constrained than CPU
      perMessageDeflate: {
        threshold: 256, // Only compress messages > 1KB
        zlibDeflateOptions: {
          memLevel: 7,
          level: 4, // Balanced compression (3 = good balance)
        },
        zlibInflateOptions: {
          memLevel: 7,
        },
        // Client must support compression
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        maxHttpBufferSize: 1e6,
        pingInterval: 25000,
        pingTimeout: 20000,
        upgradeTimeout: 10000,
        connectTimeout: 45000,
      },
      ...options,
    } as ServerOptions;

    const server = super.createIOServer(port, opts) as Server;
    if (this.pubClient && this.subClient) {
      // Type assertion needed because ioredis Redis type doesn't exactly match socket.io adapter's expected type
      // but they are compatible at runtime
      const adapter = createAdapter(
        this.pubClient as Parameters<typeof createAdapter>[0],
        this.subClient as Parameters<typeof createAdapter>[1],
      );
      server.adapter(adapter);
    }
    return server;
  }
}

import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import { Server, ServerOptions } from 'socket.io';
import { createStandaloneLogger } from '../../common/logger/logger.util';

const logger = createStandaloneLogger('RedisIoAdapter');

export class RedisIoAdapter extends IoAdapter {
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  constructor(
    private app: INestApplicationContext,
    private redisUrl: string,
  ) {
    super(app);
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
    let dbIndex: number | undefined = undefined;
    const envDb = process.env.REDIS_DB;
    if (envDb && /^\d+$/.test(envDb)) dbIndex = Number(envDb);
    if (dbIndex === undefined) {
      try {
        const u = new URL(this.redisUrl);
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
    const redisOptions: RedisOptions = {
      ...(wantsTls ? { tls: { rejectUnauthorized } } : {}),
      db: dbIndex,
    };
    this.pubClient = new Redis(this.redisUrl, redisOptions);
    this.subClient = new Redis(this.redisUrl, redisOptions);

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
    const opts: ServerOptions = {
      cors: { origin: true, credentials: true },
      transports: ['websocket', 'polling'],
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

import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'BULLMQ_CONNECTION',
      useFactory: async () => {
        const url = process.env.REDIS_BULLMQ_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
        // Authoritative REDIS_TLS flag: if set truthy => TLS, if falsy => plain. If unset => infer.
        const tlsFlag = (process.env.REDIS_TLS || '').toLowerCase();
        let wantsTls: boolean | null = null;
        if (['true', '1', 'yes'].includes(tlsFlag)) wantsTls = true;
        if (['false', '0', 'no'].includes(tlsFlag)) wantsTls = false;
        if (wantsTls === null) {
          try {
            const u = new URL(url);
            if (u.protocol === 'rediss:') wantsTls = true;
            const sslParam = u.searchParams.get('ssl') || u.searchParams.get('tls');
            if (wantsTls === null && sslParam && /^(1|true|yes)$/i.test(sslParam)) wantsTls = true;
          } catch {}
          if (wantsTls === null) wantsTls = false;
        }
        const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
        // Determine DB index: env overrides URL; default 0
        let dbIndex: number | undefined = undefined;
        const envDb = process.env.REDIS_DB;
        if (envDb && /^\d+$/.test(envDb)) dbIndex = Number(envDb);
        if (dbIndex === undefined) {
          try {
            const u = new URL(url);
            const pathDb = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : NaN;
            if (!Number.isNaN(pathDb)) dbIndex = pathDb;
            const qpDb = u.searchParams.get('db');
            if (dbIndex === undefined && qpDb && /^\d+$/.test(qpDb)) dbIndex = Number(qpDb);
          } catch {}
        }
        if (dbIndex === undefined) dbIndex = 0;
        const options = Object.assign({}, wantsTls ? { tls: { rejectUnauthorized } } : {}, { db: dbIndex });
        const client = new IORedis(url, options as any);

        // Enforce or warn about eviction policy
        try {
          const cfg = await client.config('GET', 'maxmemory-policy');
          const current = Array.isArray(cfg) ? cfg[1] : undefined;
          if (process.env.REDIS_ENFORCE_NOEVICTION === 'true') {
            if (current !== 'noeviction') {
              await client.config('SET', 'maxmemory-policy', 'noeviction');
            }
          } else if (current && current !== 'noeviction') {
            // eslint-disable-next-line no-console
            console.warn('IMPORTANT! Eviction policy is %s. It should be "noeviction"', current);
          }
        } catch {}

        return client;
      },
    },
    {
      provide: 'SESSION_QUEUE',
      useFactory: (connection: IORedis) => {
        return new Queue('session-jobs', { connection });
      },
      inject: ['BULLMQ_CONNECTION'],
    },
  ],
  exports: ['BULLMQ_CONNECTION', 'SESSION_QUEUE'],
})
export class BullmqModule implements OnModuleDestroy {
  constructor(@Inject('BULLMQ_CONNECTION') private readonly connection: IORedis) {}
  async onModuleDestroy() {
    await this.connection.quit();
  }
}



import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction } from 'express';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import IORedis from 'ioredis';

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private limiter: RateLimiterRedis;

  constructor() {
    const redisUrl =
      process.env.REDIS_URL ||
      `redis://${process.env.REDIS_USERNAME || ''}:${process.env.REDIS_PASSWORD || ''}@${
        process.env.REDIS_HOST || 'localhost'
      }:${process.env.REDIS_PORT || 6379}/${process.env.REDIS_DB || 0}`;

    const redis = new IORedis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      reconnectOnError: (err) => err.message.includes('READONLY'),
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });

    const points = parseInt(process.env.RATE_LIMIT_POINTS || '100', 10);
    const duration = parseInt(process.env.RATE_LIMIT_DURATION || '60', 10);
    const blockDuration = parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '60', 10);

    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: process.env.RATE_LIMIT_PREFIX || 'rlflx',
      points, // Requests allowed
      duration, // Per second window
      execEvenly: true,
      blockDuration,
    });
  }

  async use(req: any, res: any, next: NextFunction) {
    const url = (req.originalUrl || req.url || '') as string;
    if (
      url.startsWith('/docs') ||
      url === '/docs' ||
      url.startsWith('/swagger') ||
      url.startsWith('/ws-docs')
    ) {
      next();
      return;
    }
    const fwdHeader = (req.headers && req.headers['x-forwarded-for']) as string | string[] | undefined;
    const fwd = Array.isArray(fwdHeader) ? fwdHeader.join(',') : (fwdHeader || '');
    const fwdFirst = fwd.split(',')[0]?.trim() || '';
    const ip = fwdFirst || req.ip || (req.socket && req.socket.remoteAddress) || '';
    const key = ip || 'anon';

    try {
      await this.limiter.consume(key);
      next();
    } catch (err) {
      // Only block when the limit is actually exceeded
      if (err instanceof RateLimiterRes) {
        const body = { message: 'Too Many Requests. Please try again later.' };
        // Fastify-style reply
        if (typeof res.code === 'function' && typeof res.send === 'function') {
          res.code(429).send(body);
          return;
        }
        // Express-style response
        if (typeof res.status === 'function' && typeof res.json === 'function') {
          res.status(429).json(body);
          return;
        }
        // Low-level Node response (fallback)
        try {
          res.statusCode = 429;
          if (typeof res.setHeader === 'function') {
            res.setHeader('content-type', 'application/json');
          }
          res.end(JSON.stringify(body));
        } catch {
          next();
        }
        return;
      }
      // On Redis/store errors, fail open so users aren't blocked
      next();
    }
  }
}

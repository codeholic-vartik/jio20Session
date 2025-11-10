import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { FastifyReply, FastifyRequest } from 'fastify';
import { IncomingMessage, ServerResponse } from 'http';
import IORedis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { Socket } from 'net';
import { normalizeRedisUrl } from '../utils/redis-url.util';

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private limiter: RateLimiterRedis;

  constructor() {
    const fallbackAuth =
      process.env.REDIS_USERNAME || process.env.REDIS_PASSWORD
        ? `${process.env.REDIS_USERNAME || ''}:${
            process.env.REDIS_PASSWORD || ''
          }@`
        : '';

    const fallbackPath =
      process.env.REDIS_DB && /^\d+$/.test(process.env.REDIS_DB)
        ? `/${process.env.REDIS_DB}`
        : '';

    const rawRedisUrl =
      process.env.REDIS_URL ||
      `redis://${fallbackAuth}${process.env.REDIS_HOST || 'localhost'}:${
        process.env.REDIS_PORT || 6379
      }${fallbackPath}`;

    const redisUrl = normalizeRedisUrl(rawRedisUrl);

    const redis = new IORedis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      reconnectOnError: (err) => err.message.includes('READONLY'),
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });

    const points = parseInt(process.env.RATE_LIMIT_POINTS || '100', 10);
    const duration = parseInt(process.env.RATE_LIMIT_DURATION || '60', 10);
    const blockDuration = parseInt(
      process.env.RATE_LIMIT_BLOCK_DURATION || '60',
      10,
    );

    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: process.env.RATE_LIMIT_PREFIX || 'rlflx',
      points, // Requests allowed
      duration, // Per second window
      execEvenly: true,
      blockDuration,
    });
  }

  async use(
    req: Request | FastifyRequest,
    res: Response | FastifyReply | ServerResponse,
    next: NextFunction,
  ): Promise<void> {
    const url = this.getRequestUrl(req);
    if (this.shouldBypassUrl(url)) {
      next();
      return;
    }

    const forwardedFor = this.getForwardedFor(req);
    const clientIp = this.getClientIp(req, forwardedFor);
    const key = clientIp || 'anon';

    try {
      await this.limiter.consume(key);
      next();
    } catch (err: unknown) {
      if (err instanceof RateLimiterRes) {
        const body = { message: 'Too Many Requests. Please try again later.' };

        if (this.isFastifyReply(res)) {
          res.code(429).send(body);
          return;
        }

        if (this.isExpressResponse(res)) {
          res.status(429).json(body);
          return;
        }

        if (this.isServerResponse(res)) {
          res.statusCode = 429;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
          return;
        }
      }

      next();
    }
  }

  private getRequestUrl(req: Request | FastifyRequest): string {
    if ('originalUrl' in req && typeof req.originalUrl === 'string') {
      return req.originalUrl;
    }

    if (typeof req.url === 'string') {
      return req.url;
    }

    if ('raw' in req && this.isIncomingMessage(req.raw)) {
      return req.raw.url ?? '';
    }

    return '';
  }

  private shouldBypassUrl(url: string): boolean {
    return (
      url === '/docs' ||
      url.startsWith('/docs') ||
      url.startsWith('/swagger') ||
      url.startsWith('/ws-docs')
    );
  }

  private getForwardedFor(
    req: Request | FastifyRequest,
  ): string | string[] | undefined {
    return req.headers?.['x-forwarded-for'];
  }

  private getClientIp(
    req: Request | FastifyRequest,
    forwardedFor: string | string[] | undefined,
  ): string {
    const consolidatedForwarded = Array.isArray(forwardedFor)
      ? forwardedFor.join(',')
      : forwardedFor || '';
    const forwardedFirst = consolidatedForwarded.split(',')[0]?.trim();
    if (forwardedFirst) {
      return forwardedFirst;
    }

    if ('ip' in req && typeof req.ip === 'string' && req.ip) {
      return req.ip;
    }

    const socket = this.getSocket(req);
    return socket?.remoteAddress ?? '';
  }

  private getSocket(req: Request | FastifyRequest): Socket | undefined {
    if ('socket' in req && req.socket) {
      return req.socket;
    }

    if ('raw' in req && this.isIncomingMessage(req.raw)) {
      return req.raw.socket ?? undefined;
    }

    return undefined;
  }

  private isIncomingMessage(value: unknown): value is IncomingMessage {
    return value instanceof IncomingMessage;
  }

  private isFastifyReply(
    res: Response | FastifyReply | ServerResponse,
  ): res is FastifyReply {
    return (
      typeof (res as FastifyReply).code === 'function' &&
      typeof (res as FastifyReply).send === 'function'
    );
  }

  private isExpressResponse(
    res: Response | FastifyReply | ServerResponse,
  ): res is Response {
    return (
      typeof (res as Response).status === 'function' &&
      typeof (res as Response).json === 'function'
    );
  }

  private isServerResponse(
    res: Response | FastifyReply | ServerResponse,
  ): res is ServerResponse {
    return (
      typeof (res as ServerResponse).setHeader === 'function' &&
      typeof (res as ServerResponse).end === 'function'
    );
  }
}

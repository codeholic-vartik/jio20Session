import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import { RateLimitMiddleware } from './common/middleware/rate-limit.middleware';
import { RedisIoAdapter } from './app/socket/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await app.register(fastifyHelmet);
  await app.register(fastifyCors, { origin: true, credentials: true });
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisIoAdapter = new RedisIoAdapter(app, redisUrl);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter as any);
  app.use(new RateLimitMiddleware().use as any);
  const port = parseInt(process.env.PORT ?? '', 10) || 9000;
  await app.listen(port, '0.0.0.0');
  const url = await app.getUrl();
  Logger.log(`Application is running at ${url}`, 'Bootstrap');
  const fastify = app.getHttpAdapter().getInstance();
  try {
    const routesTree = fastify.printRoutes();
    Logger.log(`Available routes on ${url}:\n${routesTree}`, 'Routes');
  } catch (e) {
    Logger.warn('Could not print routes (fastify.printRoutes unavailable).', 'Routes');
  }
}
bootstrap();

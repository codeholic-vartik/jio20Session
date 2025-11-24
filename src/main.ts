import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { registerWsDocsUi } from './common/templates/ws-docs-ui';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import { RateLimitMiddleware } from './common/middleware/rate-limit.middleware';
import { RedisIoAdapter } from './app/socket/redis-io.adapter';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AsyncApiDocumentBuilder, AsyncApiModule } from 'nestjs-asyncapi';
import { createStandaloneLogger } from './common/logger/logger.util';
import { normalizeRedisUrl } from './common/utils/redis-url.util';

const isDevelopment = process.env.NODE_ENV !== 'production';
// Use NestJS built-in Logger for development, Winston for production
const nestLogger = new Logger('Bootstrap');
const standaloneLogger = createStandaloneLogger('Bootstrap');

// Unified logger interface
const logger = isDevelopment
  ? {
      log: (message: string) => nestLogger.log(message),
      error: (message: string, trace?: string) =>
        nestLogger.error(message, trace),
      warn: (message: string) => nestLogger.warn(message),
      debug: (message: string) => nestLogger.debug(message),
      info: (message: string) => nestLogger.log(message), // NestJS Logger uses log for info
    }
  : standaloneLogger;

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await app.register(fastifyHelmet);
  await app.register(fastifyCors, { origin: true, credentials: true });
  const redisUrl = normalizeRedisUrl(
    process.env.REDIS_URL || process.env.REDIS_BULLMQ_URL || undefined,
  );
  const redisIoAdapter = new RedisIoAdapter(app, redisUrl);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  const rateLimit = new RateLimitMiddleware();
  app.use(rateLimit.use.bind(rateLimit));

  // Swagger/OpenAPI for REST endpoints
  const config = new DocumentBuilder()
    .setTitle('Jio20 Session Service')
    .setDescription('REST API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  // Serve Swagger UI and JSON via Nest's SwaggerModule only (avoids route duplication)
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/json' });

  const port = parseInt(process.env.PORT ?? '', 10) || 9000;

  // AsyncAPI for WebSocket documentation
  // Compute WebSocket URL - will be updated after app.listen() if needed
  const isHttps =
    process.env.NODE_ENV === 'production' || process.env.HTTPS === 'true';
  const wsProtocol = isHttps ? 'wss' : 'ws';
  const host = process.env.HOST || process.env.WEBSOCKET_HOST || 'localhost';
  // When behind reverse proxy, don't include port in URL (use standard ports)
  const includePort = process.env.WEBSOCKET_INCLUDE_PORT !== 'false';
  const standardPort = isHttps ? 443 : 80;
  const wsUrl =
    port === standardPort || !includePort
      ? `${wsProtocol}://${host}`
      : `${wsProtocol}://${host}:${port}`;

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  const asyncApiOptions = (new AsyncApiDocumentBuilder() as any)
    .setTitle('Jio20 Session WebSocket API')
    .setDescription('Socket.IO based realtime API')
    .setVersion('1.0.0')
    .setDefaultContentType('application/json')
    .addSecurity('bearerAuth', {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
    .addServer('default', {
      url: wsUrl,
      protocol: 'socket.io',
      description: 'Primary WebSocket server',
    })
    .build();

  const asyncapiDocument = (AsyncApiModule as any).createDocument(
    app,
    asyncApiOptions,
  );
  await (AsyncApiModule as any).setup('/ws-docs', app, asyncapiDocument);
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

  // Minimal interactive Socket.IO test UI at /ws-docs/ui (extracted)
  registerWsDocsUi(app);
  await app.listen(port, '0.0.0.0');
  const url = await app.getUrl();
  logger.info(`Application is running at ${url}`);
  try {
    const fastify = app.getHttpAdapter().getInstance();
    const routesTree = fastify.printRoutes();
    logger.info(`Available routes on ${url}:\n${routesTree}`);
  } catch {
    logger.warn('Could not print routes (fastify.printRoutes unavailable).');
  }
}
void bootstrap();

import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.string().optional(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  REDIS_BULLMQ_URL: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  LOG_DIR: z.string().optional().default('logs'),
  LOG_RETENTION_DAYS: z.string().optional().default('30'),
  WEBSOCKET_NAMESPACE: z.string().optional().default('/ws/v1/session/'),
});

function validateEnv(config: Record<string, unknown>) {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const message = result.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}

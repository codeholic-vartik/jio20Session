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
  REDIS_DB: z
    .string()
    .optional()
    .default('0')
    .refine(
      (value) =>
        /^\d+$/.test(value) &&
        Number.parseInt(value, 10) >= 0 &&
        Number.parseInt(value, 10) <= 15,
      {
        message: 'REDIS_DB must be an integer between 0 and 15',
      },
    ),
  REDIS_BULLMQ_DB: z
    .string()
    .optional()
    .refine(
      (value) =>
        !value ||
        (/^\d+$/.test(value) &&
          Number.parseInt(value, 10) >= 0 &&
          Number.parseInt(value, 10) <= 15),
      {
        message: 'REDIS_BULLMQ_DB must be an integer between 0 and 15',
      },
    ),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  LOG_DIR: z.string().optional().default('logs'),
  LOG_RETENTION_DAYS: z.string().optional().default('30'),
  WEBSOCKET_NAMESPACE: z.string().optional().default('/ws/v1/session/'),
  JWT_SECRET_KEY: z
    .string()
    .optional()
    .default('your-super-secret-jwt-key-change-this-in-production'),
  JWT_REFRESH_SECRET_KEY: z
    .string()
    .optional()
    .default('your-super-secret-refresh-key-change-this-in-production'),
  SESSION_SYNC_SALES_BATCH_SIZE: z
    .string()
    .optional()
    .refine(
      (value) =>
        !value ||
        (/^\d+$/.test(value) &&
          Number.parseInt(value, 10) > 0 &&
          Number.parseInt(value, 10) <= 1000),
      {
        message:
          'SESSION_SYNC_SALES_BATCH_SIZE must be a positive integer less than or equal to 1000',
      },
    ),
  RAZORPAY_CLIENT: z.string().optional(),
  RAZORPAY_SECRET: z.string().optional(),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .optional()
    .describe(
      'SHA-256 hash (hex string) for encrypting coupon codes. Must be 64 hex characters.',
    ),
  COUPON_CODE_PREFIX: z.string().optional().default('SES'),
  COUPON_RANDOM_SUFFIX_LENGTH: z
    .string()
    .optional()
    .default('6')
    .refine(
      (value) =>
        /^\d+$/.test(value) &&
        Number.parseInt(value, 10) > 0 &&
        Number.parseInt(value, 10) <= 20,
      {
        message:
          'COUPON_RANDOM_SUFFIX_LENGTH must be a positive integer between 1 and 20',
      },
    ),
  COUPON_SCUID_PREFIX: z.string().optional().default('sc'),
  COUPON_SCUID_NANO_LENGTH: z
    .string()
    .optional()
    .default('8')
    .refine(
      (value) =>
        /^\d+$/.test(value) &&
        Number.parseInt(value, 10) > 0 &&
        Number.parseInt(value, 10) <= 20,
      {
        message:
          'COUPON_SCUID_NANO_LENGTH must be a positive integer between 1 and 20',
      },
    ),
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

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
  SENTRY_RELEASE: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  LOG_DIR: z.string().optional().default('logs'),
  LOG_RETENTION_DAYS: z.string().optional().default('30'),
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
  SESSION_STOP_TRIGGER_TYPE: z.string().optional(),
  SESSION_STOP_TRIGGER_VALUE: z
    .string()
    .optional()
    .refine(
      (value) => {
        if (!value) {
          return true;
        }

        return /^\d+$/.test(value) && Number.parseInt(value, 10) >= 0;
      },
      {
        message: 'SESSION_STOP_TRIGGER_VALUE must be a non-negative integer',
      },
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
  MAX_SESSION_COUPON_APPLY: z
    .string()
    .optional()
    .refine(
      (value) =>
        !value ||
        (/^\d+$/.test(value) &&
          Number.parseInt(value, 10) > 0 &&
          Number.parseInt(value, 10) <= 100),
      {
        message:
          'MAX_SESSION_COUPON_APPLY must be a positive integer between 1 and 100',
      },
    )
    .describe(
      'Maximum number of times a user can win in a session. If set, users cannot apply more coupons after reaching this limit.',
    ),
  COUPON_INVALIDATE: z
    .string()
    .optional()
    .refine((value) => !value || value === 'true' || value === 'false', {
      message: 'COUPON_INVALIDATE must be "true" or "false"',
    })
    .default('false')
    .describe(
      'If true, invalidates all remaining coupons for a user in a session when they reach MAX_SESSION_COUPON_APPLY limit.',
    ),
  SESSION_REDIS_TTL_DAYS: z
    .string()
    .optional()
    .default('30')
    .refine(
      (value) =>
        /^\d+$/.test(value) &&
        Number.parseInt(value, 10) > 0 &&
        Number.parseInt(value, 10) <= 365,
      {
        message:
          'SESSION_REDIS_TTL_DAYS must be a positive integer between 1 and 365',
      },
    )
    .describe(
      'TTL in days for Redis session keys after session completion. Keys will auto-expire after this duration. Default: 30 days.',
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

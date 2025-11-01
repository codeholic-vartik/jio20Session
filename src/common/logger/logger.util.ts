import { Logger } from '@nestjs/common';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Creates a standalone logger instance for use outside of NestJS dependency injection
 * (e.g., in workers, standalone scripts, etc.)
 * Uses NestJS Logger for development, Winston for production
 */
export function createStandaloneLogger(context?: string): {
  log: (message: string, context?: string) => void;
  error: (message: string, trace?: string, context?: string) => void;
  warn: (message: string, context?: string) => void;
  debug: (message: string, context?: string) => void;
  info: (message: string, context?: string) => void;
} {
  const isDevelopment = process.env.NODE_ENV !== 'production';

  if (isDevelopment) {
    // Use NestJS built-in Logger for development
    const nestLogger = new Logger(context);
    return {
      log: (message: string, ctx?: string) =>
        nestLogger.log(message, ctx || context),
      error: (message: string, trace?: string, ctx?: string) =>
        nestLogger.error(message, trace, ctx || context),
      warn: (message: string, ctx?: string) =>
        nestLogger.warn(message, ctx || context),
      debug: (message: string, ctx?: string) =>
        nestLogger.debug(message, ctx || context),
      info: (message: string, ctx?: string) =>
        nestLogger.log(message, ctx || context),
    };
  }

  // Production: Use Winston with file rotation
  const logDir = process.env.LOG_DIR || 'logs';
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);
  const logLevel =
    (process.env.LOG_LEVEL as
      | 'error'
      | 'warn'
      | 'info'
      | 'debug'
      | 'verbose') || 'info';

  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const winstonLogger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    defaultMeta: { service: 'jio20-session', context },
    transports: [
      // Console transport
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
        ),
      }),
      // Daily rotate file for all logs
      new DailyRotateFile({
        filename: path.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: `${retentionDays}d`,
        zippedArchive: true,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json(),
        ),
      }),
      // Separate file for errors
      new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxSize: '10m',
        maxFiles: `${retentionDays}d`,
        zippedArchive: true,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json(),
        ),
      }),
    ],
  });

  return {
    log: (message: string, ctx?: string) =>
      winstonLogger.info(message, { context: ctx || context }),
    error: (message: string, trace?: string, ctx?: string) =>
      winstonLogger.error(message, { trace, context: ctx || context }),
    warn: (message: string, ctx?: string) =>
      winstonLogger.warn(message, { context: ctx || context }),
    debug: (message: string, ctx?: string) =>
      winstonLogger.debug(message, { context: ctx || context }),
    info: (message: string, ctx?: string) =>
      winstonLogger.info(message, { context: ctx || context }),
  };
}

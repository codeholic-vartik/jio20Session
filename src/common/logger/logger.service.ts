import {
  Injectable,
  LoggerService as NestLoggerService,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: NestLoggerService;
  private readonly isDevelopment: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isDevelopment =
      this.configService.get<string>('NODE_ENV') !== 'production';

    if (this.isDevelopment) {
      // Use NestJS built-in Logger for development
      this.logger = new Logger();
    } else {
      // Use Winston for production with file rotation
      const logDir = this.configService.get<string>('LOG_DIR') || 'logs';
      const retentionDays = parseInt(
        this.configService.get<string>('LOG_RETENTION_DAYS') || '30',
        10,
      );

      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const logLevel =
        (this.configService.get<string>('LOG_LEVEL') as
          | 'error'
          | 'warn'
          | 'info'
          | 'debug'
          | 'verbose') || 'info';

      // Create Winston logger with daily rotate file transport
      const winstonLogger = winston.createLogger({
        level: logLevel,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
        defaultMeta: { service: 'jio20-session' },
        transports: [
          // Console transport for all logs
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

      // Create adapter to match NestJS LoggerService interface
      this.logger = {
        log: (message: string, context?: string) => {
          winstonLogger.info(message, { context });
        },
        error: (message: string, trace?: string, context?: string) => {
          winstonLogger.error(message, { trace, context });
        },
        warn: (message: string, context?: string) => {
          winstonLogger.warn(message, { context });
        },
        debug: (message: string, context?: string) => {
          winstonLogger.debug(message, { context });
        },
        verbose: (message: string, context?: string) => {
          winstonLogger.verbose(message, { context });
        },
        fatal: (message: string, context?: string) => {
          winstonLogger.error(message, { context, level: 'fatal' });
        },
      };
    }
  }

  log(message: string, context?: string): void {
    this.logger.log(message, context);
  }

  error(message: string, trace?: string, context?: string): void {
    this.logger.error(message, trace, context);
  }

  warn(message: string, context?: string): void {
    this.logger.warn(message, context);
  }

  debug(message: string, context?: string): void {
    this.logger.debug(message, context);
  }

  verbose(message: string, context?: string): void {
    this.logger.verbose(message, context);
  }

  fatal(message: string, context?: string): void {
    this.logger.fatal(message, context);
  }
}

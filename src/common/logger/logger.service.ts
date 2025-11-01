import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pino from 'pino';
import * as fs from 'fs';
import rfs from 'rotating-file-stream';

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: pino.Logger;

  constructor(private readonly configService: ConfigService) {
    const logLevel =
      (this.configService.get<string>('LOG_LEVEL') as
        | 'fatal'
        | 'error'
        | 'warn'
        | 'info'
        | 'debug'
        | 'trace') || 'info';

    const isDevelopment =
      this.configService.get<string>('NODE_ENV') !== 'production';

    const logDir = this.configService.get<string>('LOG_DIR') || 'logs';
    const retentionDays = parseInt(
      this.configService.get<string>('LOG_RETENTION_DAYS') || '30',
      10,
    );

    // Ensure log directory exists
    if (!isDevelopment) {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }

    // Configure transport for pretty printing in development
    let transport:
      | pino.TransportMultiOptions
      | pino.TransportSingleOptions
      | undefined;
    if (isDevelopment) {
      try {
        // Try to use pino-pretty if available
        require.resolve('pino-pretty');
        transport = {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        };
      } catch {
        // pino-pretty not installed, use basic formatting
        transport = undefined;
      }
    } else {
      // Production: Use file rotation with rotating-file-stream
      // Create rotating streams for app logs and error logs
      const appLogStream = rfs.createStream('app-%Y-%m-%d.log', {
        path: logDir,
        size: '10M', // Rotate when file reaches 10MB
        interval: '1d', // Rotate daily
        maxFiles: retentionDays, // Keep logs for specified days
        compress: 'gzip', // Compress old logs
      });

      const errorLogStream = rfs.createStream('error-%Y-%m-%d.log', {
        path: logDir,
        size: '10M',
        interval: '1d',
        maxFiles: retentionDays,
        compress: 'gzip',
      });

      // Use multi-stream transport to write to both files
      transport = {
        targets: [
          {
            target: 'pino/file',
            level: 'info',
            options: { destination: appLogStream },
          },
          {
            target: 'pino/file',
            level: 'error',
            options: { destination: errorLogStream },
          },
        ],
      };
    }

    this.logger = pino({
      level: logLevel,
      transport,
      formatters: {
        level: (label) => {
          return { level: label.toUpperCase() };
        },
      },
      base: isDevelopment ? undefined : { pid: process.pid },
    });
  }

  log(message: string, context?: string): void {
    this.logger.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, message);
  }

  warn(message: string, context?: string): void {
    this.logger.warn({ context }, message);
  }

  debug(message: string, context?: string): void {
    this.logger.debug({ context }, message);
  }

  verbose(message: string, context?: string): void {
    this.logger.trace({ context }, message);
  }

  fatal(message: string, context?: string): void {
    this.logger.fatal({ context }, message);
  }

  /**
   * Get the underlying Pino logger instance for advanced usage
   */
  getPinoLogger(): pino.Logger {
    return this.logger;
  }
}

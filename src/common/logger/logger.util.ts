import pino from 'pino';
import * as fs from 'fs';
import rfs from 'rotating-file-stream';

/**
 * Creates a standalone logger instance for use outside of NestJS dependency injection
 * (e.g., in workers, standalone scripts, etc.)
 */
export function createStandaloneLogger(context?: string): pino.Logger {
  const logLevel =
    (process.env.LOG_LEVEL as
      | 'fatal'
      | 'error'
      | 'warn'
      | 'info'
      | 'debug'
      | 'trace') || 'info';

  const isDevelopment = process.env.NODE_ENV !== 'production';
  const logDir = process.env.LOG_DIR || 'logs';
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);

  // Ensure log directory exists in production
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

  const logger = pino({
    level: logLevel,
    transport,
    formatters: {
      level: (label) => {
        return { level: label.toUpperCase() };
      },
    },
    base: isDevelopment ? undefined : { pid: process.pid },
  });

  // If context is provided, create a child logger with context
  return context ? logger.child({ context }) : logger;
}

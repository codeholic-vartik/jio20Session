import { Global, Module } from '@nestjs/common';
import * as Sentry from '@sentry/node';

@Global()
@Module({})
export class ObservabilityModule {
  constructor() {
    const dsn = process.env.SENTRY_DSN;
    if (dsn) {
      Sentry.init({ dsn, tracesSampleRate: 0.1 });
    }
  }
}

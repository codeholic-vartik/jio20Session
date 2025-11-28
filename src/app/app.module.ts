import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '../common/config/config.module';
import { DatabaseModule } from '../common/database/database.module';
import { BullmqModule } from './jobs/bullmq.module';
import { RedisSubscriberModule } from './jobs/redis-subscriber.module';
import { SocketModule } from './socket/socket.module';
import { HealthModule } from '../common/health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { SessionModule } from './session/session.module';
import { LoggerModule } from '../common/logger/logger.module';
import { AuthModule } from './auth/auth.module';
import { CouponModule } from './coupon/coupon.module';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';

@Module({
  imports: [
    ConfigModule,
    // SentryModule must be imported to enable Sentry integrations
    SentryModule.forRoot(),
    LoggerModule,
    DatabaseModule,
    BullmqModule,
    RedisSubscriberModule,
    AuthModule,
    SocketModule,
    HealthModule,
    MetricsModule,
    SessionModule,
    CouponModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global exception filter reports to Sentry and returns a consistent response
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}

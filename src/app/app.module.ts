import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '../common/config/config.module';
import { DatabaseModule } from '../common/database/database.module';
import { BullmqModule } from './jobs/bullmq.module';
import { RedisSubscriberModule } from './jobs/redis-subscriber.module';
import { SocketModule } from './socket/socket.module';
import { HealthModule } from '../common/health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ObservabilityModule } from '../common/observability/observability.module';
import { SessionModule } from './session/session.module';
import { LoggerModule } from '../common/logger/logger.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    BullmqModule,
    RedisSubscriberModule,
    AuthModule,
    SocketModule,
    HealthModule,
    MetricsModule,
    ObservabilityModule,
    SessionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

import { Module, type Provider } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { AuthModule } from '../auth/auth.module';
import { BullmqModule } from '../jobs/bullmq.module';
import { SessionRealtimeService } from './realtime/session-realtime.service';
import { SessionCounterService } from './realtime/session-counter.service';
import { SessionPublisherService } from './realtime/session-publisher.service';
import { PingService } from './services/ping.service';
import { SocketPingController } from './controllers/ping.controller';

const SOCKET_PROVIDERS = [
  SocketGateway,
  SessionRealtimeService,
  SessionCounterService,
  SessionPublisherService,
  PingService,
  SocketPingController,
] as const;

const SOCKET_EXPORTS = [
  SocketGateway,
  SessionRealtimeService,
  SessionCounterService,
  SessionPublisherService,
] as const;

@Module({
  imports: [AuthModule, BullmqModule],
  providers: SOCKET_PROVIDERS as unknown as Provider[],
  exports: SOCKET_EXPORTS as unknown as Provider[],
})
export class SocketModule {}

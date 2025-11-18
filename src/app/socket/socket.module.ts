import { Module } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { AuthModule } from '../auth/auth.module';
import { BullmqModule } from '../jobs/bullmq.module';
import { SessionRealtimeService } from './realtime/session-realtime.service';
import { SessionCounterService } from './realtime/session-counter.service';
import { SessionPublisherService } from './realtime/session-publisher.service';

@Module({
  imports: [AuthModule, BullmqModule],
  providers: [
    SocketGateway,
    SessionRealtimeService,
    SessionCounterService,
    SessionPublisherService,
  ],
  exports: [
    SocketGateway,
    SessionRealtimeService,
    SessionCounterService,
    SessionPublisherService,
  ],
})
export class SocketModule {}

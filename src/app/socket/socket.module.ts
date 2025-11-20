import { Module, type Provider } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';
import { AuthModule } from '../auth/auth.module';
import { BullmqModule } from '../jobs/bullmq.module';

import { SessionCounterService } from './services/session-counter.service';

import { PingService } from './services/ping.service';
import { SocketPingController } from './controllers/ping.controller';
import { TaxonomySalesService } from './services/taxonomy-sales.service';
import { SocketTaxonomyController } from './controllers/taxonomy.controller';

const SOCKET_PROVIDERS = [
  SocketGateway,
  SessionCounterService,
  PingService,
  SocketPingController,
  TaxonomySalesService,
  SocketTaxonomyController,
] as const;

const SOCKET_EXPORTS = [SocketGateway, SessionCounterService] as const;

@Module({
  imports: [AuthModule, BullmqModule],
  providers: SOCKET_PROVIDERS as unknown as Provider[],
  exports: SOCKET_EXPORTS as unknown as Provider[],
})
export class SocketModule {}

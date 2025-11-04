import { Module, forwardRef } from '@nestjs/common';
import { RedisSubscriberService } from './redis-subscriber.service';
import { SessionModule } from '../session/session.module';
import { SocketModule } from '../socket/socket.module';

@Module({
  imports: [SessionModule, forwardRef(() => SocketModule)],
  providers: [RedisSubscriberService],
  exports: [RedisSubscriberService],
})
export class RedisSubscriberModule {}

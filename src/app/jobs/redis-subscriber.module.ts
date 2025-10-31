import { Module } from '@nestjs/common';
import { RedisSubscriberService } from './redis-subscriber.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  providers: [RedisSubscriberService],
  exports: [RedisSubscriberService],
})
export class RedisSubscriberModule {}

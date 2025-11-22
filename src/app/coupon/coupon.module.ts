import { Module } from '@nestjs/common';
import { CouponController } from './coupon.controller';
import { CouponService } from './coupon.service';
import { AuthModule } from '../auth/auth.module';
import { CouponGeneratorService } from './utils/coupon-generator.service';
import { DatabaseModule } from '../../common/database/database.module';
import { BullmqModule } from '../jobs/bullmq.module';

@Module({
  imports: [AuthModule, DatabaseModule, BullmqModule],
  controllers: [CouponController],
  providers: [CouponService, CouponGeneratorService],
  exports: [CouponGeneratorService],
})
export class CouponModule {}

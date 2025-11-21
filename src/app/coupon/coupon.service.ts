import { Injectable } from '@nestjs/common';

@Injectable()
export class CouponService {
  applyCoupon() {
    return {
      success: true,
      message: 'Coupon applied successfully! This is a dummy message.',
    };
  }
}

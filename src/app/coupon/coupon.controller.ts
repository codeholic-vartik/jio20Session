import { Controller, Post, UseGuards, Body, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CouponService } from './coupon.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { AuthenticatedUser } from '../auth/jwt-auth.service';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

@ApiTags('coupon')
@Controller('coupon')
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Post('apply')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Apply a coupon to session' })
  @ApiResponse({
    status: 200,
    description: 'Coupon applied successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        position: { type: 'number' },
        is_winner: { type: 'boolean' },
        applied_at: { type: 'string', format: 'date-time' },
        max_slots: { type: 'number' },
        slots_remaining: { type: 'number', nullable: true },
        reward_created: { type: 'boolean' },
        participant_count: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid or missing JWT token',
  })
  @ApiResponse({
    status: 404,
    description: 'Coupon or session not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid coupon or session state',
  })
  @ApiResponse({
    status: 409,
    description: 'Coupon already applied or session full',
  })
  async applyCoupon(
    @Body() dto: ApplyCouponDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    return this.couponService.applyCoupon(userId, dto.coupon_code);
  }
}

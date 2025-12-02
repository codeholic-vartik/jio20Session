import {
  Controller,
  Post,
  Get,
  UseGuards,
  Body,
  Request,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
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

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get coupon status - check if applied, winner, or in queue',
  })
  @ApiQuery({
    name: 'coupon_code',
    description: 'Plain text coupon code to check status',
    example: 'SES-1-1z-83uqO4fId-E5P5HA',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Coupon status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        coupon_code: { type: 'string' },
        session_suid: { type: 'string', nullable: true },
        status: {
          type: 'string',
          enum: ['not_found', 'not_applied', 'in_queue', 'applied', 'winner'],
        },
        is_winner: { type: 'boolean' },
        is_applied: { type: 'boolean' },
        in_queue: { type: 'boolean' },
        position: { type: 'number', nullable: true },
        applied_at: { type: 'string', format: 'date-time', nullable: true },
        job_id: { type: 'string', nullable: true },
        job_state: { type: 'string', nullable: true },
        message: { type: 'string' },
        reward_product: {
          type: 'object',
          nullable: true,
          properties: {
            puid: { type: 'string' },
            slug: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string', nullable: true },
            sku: { type: 'string', nullable: true },
            original_price: { type: 'number' },
            current_price: { type: 'number' },
            images: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  piuid: { type: 'string' },
                  image_url: { type: 'string' },
                  is_primary: { type: 'boolean', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid or missing JWT token',
  })
  async getCouponStatus(
    @Query('coupon_code') couponCode: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    if (!couponCode) {
      throw new Error('Coupon code is required');
    }

    return this.couponService.getCouponStatus(userId, couponCode);
  }
}

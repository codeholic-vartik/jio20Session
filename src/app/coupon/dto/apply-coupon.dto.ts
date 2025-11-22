import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class ApplyCouponDto {
  @ApiProperty({
    description: 'Plain text coupon code to apply',
    example: 'SES-1-1z-83uqO4fId-E5P5HA',
    minLength: 3,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  coupon_code: string;
}

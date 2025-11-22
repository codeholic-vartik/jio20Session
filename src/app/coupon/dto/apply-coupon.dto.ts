import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class ApplyCouponDto {
  @ApiProperty({
    description: 'Plain text coupon code to apply',
    example: 'SES11z83uqO4fIdE5P5HA',
    minLength: 3,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  coupon_code: string;
}

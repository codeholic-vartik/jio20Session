import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class CouponStatusDto {
  @ApiProperty({
    description: 'Plain text coupon code to check status',
    example: 'SES11z83uqO4fIdE5P5HA',
  })
  @IsString()
  @IsNotEmpty()
  coupon_code: string;
}

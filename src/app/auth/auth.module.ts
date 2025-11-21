import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtAuthService } from './jwt-auth.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>(
          'JWT_SECRET_KEY',
          'your-super-secret-jwt-key-change-this-in-production',
        ),
        signOptions: {
          // Token expiration can be configured here if needed
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [JwtAuthService, WsJwtGuard, JwtAuthGuard],
  exports: [JwtAuthService, WsJwtGuard, JwtAuthGuard, JwtModule],
})
export class AuthModule {}

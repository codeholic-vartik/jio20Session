import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/jwt-auth.service';

export interface PingUserPayload {
  uuid: string;
  first_name: string | null | undefined;
  last_name: string | null | undefined;
  username: string | null | undefined;
  email: string | null | undefined;
  phone_number: string | null | undefined;
}

export interface PingResponseDto {
  timestamp: string;
  user: PingUserPayload;
}

@Injectable()
export class PingService {
  buildPingResponse(user: AuthenticatedUser): PingResponseDto {
    return {
      timestamp: new Date().toISOString(),
      user: {
        uuid: user.userUuid,
        first_name: user.firstName ?? null,
        last_name: user.lastName ?? null,
        username: user.username ?? null,
        email: user.email ?? null,
        phone_number: user.phoneNumber ?? null,
      },
    };
  }
}

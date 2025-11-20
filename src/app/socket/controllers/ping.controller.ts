import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/jwt-auth.service';
import { PingResponseDto, PingService } from '../services/ping.service';

@Injectable()
export class SocketPingController {
  constructor(private readonly pingService: PingService) {}

  buildPingPayload(user: AuthenticatedUser): PingResponseDto {
    return this.pingService.buildPingResponse(user);
  }
}

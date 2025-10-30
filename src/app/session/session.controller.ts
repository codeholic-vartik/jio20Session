import { Controller, Get } from '@nestjs/common';
import { SessionService } from './session.service';

@Controller('sessions')
export class SessionController {
  constructor(private readonly service: SessionService) {}

  @Get('active')
  active() {
    return this.service.getActiveSessions();
  }
}



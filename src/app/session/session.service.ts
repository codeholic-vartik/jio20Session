import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: DatabaseService) {}

  async getActiveSessions() {
    return this.prisma.sessions.findMany({ where: { is_active: true }, take: 100 });
  }
}



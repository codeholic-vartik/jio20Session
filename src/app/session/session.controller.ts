import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { SessionService } from './session.service';

@Controller('sessions')
export class SessionController {
  constructor(private readonly service: SessionService) {}

  @Get('active')
  active() {
    return this.service.getActiveSessions();
  }

  /**
   * Check if sales are enabled for a taxonomy term.
   * FastAPI calls this before allowing order creation.
   *
   * @param termId - The taxonomy term ID
   * @returns Object with enabled status
   */
  @Get('taxonomy/:termId/sales-enabled')
  async checkSalesEnabled(@Param('termId', ParseIntPipe) termId: number) {
    const enabled = await this.service.isSalesEnabled(termId);
    return {
      term_id: termId,
      sales_enabled: enabled,
    };
  }
}

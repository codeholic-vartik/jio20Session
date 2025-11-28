import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Test endpoint to verify Sentry is working
   * This endpoint intentionally throws an error for testing
   * Visit: GET /debug-sentry
   */
  @Get('debug-sentry')
  getError() {
    throw new Error('My first Sentry error!');
  }
}

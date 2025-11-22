import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtAuthService, AuthenticatedUser } from '../jwt-auth.service';

/**
 * Extended Request interface with authenticated user information
 */
interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  headers: {
    authorization?: string;
    [key: string]: unknown;
  };
}

/**
 * REST API JWT Authentication Guard
 * Validates JWT tokens on HTTP requests
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly jwtAuthService: JwtAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      // Get HTTP request from context
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

      // Extract token from Authorization header
      const authHeader = request.headers?.authorization;

      if (!authHeader || typeof authHeader !== 'string') {
        this.logger.warn('No authorization header provided');
        throw new UnauthorizedException('Authentication required');
      }

      // Extract token (supports "Bearer TOKEN" format)
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      if (!token) {
        this.logger.warn('No token provided in authorization header');
        throw new UnauthorizedException('Authentication required');
      }

      // Validate JWT token using JwtAuthService
      const userInfo = await this.jwtAuthService.validateToken(token);

      // Attach user info to request for use in controllers
      request.user = userInfo;

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Authentication failed';

      this.logger.warn(`REST API auth failed: ${errorMessage}`);

      throw new UnauthorizedException('Invalid authentication token');
    }
  }
}

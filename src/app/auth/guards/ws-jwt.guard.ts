import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { JwtAuthService, AuthenticatedUser } from '../jwt-auth.service';
import { AuthenticatedSocket } from '../types/socket.types';

/**
 * WebSocket JWT Authentication Guard
 * Validates JWT tokens on Socket.IO connections
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtAuthService: JwtAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      // Get socket from context and cast to AuthenticatedSocket
      const client = context.switchToWs().getClient<AuthenticatedSocket>();

      // Extract token from socket handshake
      const token = this.jwtAuthService.extractTokenFromSocket(client);

      if (!token) {
        this.logger.warn(
          `Connection rejected: No token provided for client ${client.id}`,
        );
        throw new WsException({
          message: 'Authentication required',
          code: 'AUTH_REQUIRED',
        });
      }

      // Validate JWT token
      const userInfo: AuthenticatedUser =
        await this.jwtAuthService.validateToken(token);

      // Attach user info to socket for use in handlers
      client.user = userInfo;

      // Join user-specific rooms for targeted messages
      await client.join(`user:${userInfo.userId}`);
      await client.join(`user:${userInfo.userUuid}`);

      return true;
    } catch (error) {
      if (error instanceof WsException) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Authentication failed';

      this.logger.warn(`WebSocket auth failed: ${errorMessage}`);

      throw new WsException({
        message: errorMessage,
        code: 'AUTH_FAILED',
      });
    }
  }
}

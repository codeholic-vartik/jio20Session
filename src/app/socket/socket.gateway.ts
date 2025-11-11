import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { JwtAuthService } from '../auth/jwt-auth.service';
import {
  AuthenticatedSocket,
  isAuthenticatedSocket,
} from '../auth/types/socket.types';
import type { AuthenticatedUser } from '../auth/jwt-auth.service';

const WEBSOCKET_NAMESPACE =
  process.env.WEBSOCKET_NAMESPACE || '/ws/v1/session/';

@WebSocketGateway({
  namespace: WEBSOCKET_NAMESPACE,
  cors: { origin: true, credentials: true },
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(SocketGateway.name);
  private connectionCount = 0;

  constructor(private readonly jwtAuthService: JwtAuthService) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Extract token from socket handshake
      const token = this.jwtAuthService.extractTokenFromSocket(client);

      if (!token) {
        this.rejectConnection(
          client,
          'Authentication required',
          'AUTH_REQUIRED',
        );
        return;
      }

      // Validate JWT token
      const userInfo = await this.jwtAuthService.validateToken(token);

      // Attach user info to socket
      client.user = userInfo;

      // Join user-specific rooms for targeted messages
      this.joinUserRooms(client, userInfo);

      // Update connection count and log
      this.connectionCount++;
      this.logConnection(client, userInfo);

      // Send authentication success event
      client.emit('authenticated', {
        userId: userInfo.userId,
        userUuid: userInfo.userUuid,
        message: 'Successfully authenticated',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Authentication failed';
      this.rejectConnection(client, errorMessage, 'AUTH_FAILED');
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    const userId = client.user?.userId || 'unknown';
    this.logger.debug(`Client disconnected: ${client.id}, userId: ${userId}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    const authClient = client as AuthenticatedSocket;
    if (!isAuthenticatedSocket(authClient) || !authClient.user) {
      authClient.emit('error', {
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const user = authClient.user;
    authClient.emit('pong', {
      timestamp: new Date().toISOString(),
      userId: user.userId,
    });
  }

  /**
   * Broadcasts participant count update to all connected clients
   * Optimized for high concurrency (100k+ users)
   */
  broadcastParticipantUpdate(
    suid: string,
    participantCount: number,
    sessionProfileId: number,
    sessionId?: number,
    position?: number,
    isWinner?: boolean,
  ): void {
    const payload: {
      suid: string;
      participant_count: number;
      session_profile_id: number;
      updated_at: string;
      session_id?: number;
      position?: number;
      is_winner?: boolean;
    } = {
      suid,
      participant_count: participantCount,
      session_profile_id: sessionProfileId,
      updated_at: new Date().toISOString(),
    };

    if (sessionId !== undefined) payload.session_id = sessionId;
    if (position !== undefined) payload.position = position;
    if (isWinner !== undefined) payload.is_winner = isWinner;

    // Broadcast to all clients (uses Redis adapter for multi-server scaling)
    this.server.emit('participant:count:update', payload);

    // Also broadcast to session-specific room (using suid)
    this.server.to(`session:${suid}`).emit('participant:count:update', payload);

    // Only log at debug level to reduce overhead
    this.logger.debug(
      `Broadcasted participant update: suid=${suid}, count=${participantCount}`,
    );
  }

  /**
   * Broadcasts sales count update to all connected clients
   * Optimized for high concurrency (100k+ users)
   */
  broadcastSalesCountUpdate(
    sessionId: number,
    count: number,
    sessionProfileId?: number,
  ): void {
    const payload: {
      session_id: number;
      count: number;
      updated_at: string;
      session_profile_id?: number;
    } = {
      session_id: sessionId,
      count,
      updated_at: new Date().toISOString(),
    };

    if (sessionProfileId !== undefined) {
      payload.session_profile_id = sessionProfileId;
    }

    // Broadcast to all clients (uses Redis adapter for multi-server scaling)
    this.server.emit('sales:count:update', payload);

    // Also broadcast to session-specific room
    this.server.to(`session:${sessionId}`).emit('sales:count:update', payload);

    // Only log at debug level to reduce overhead
    this.logger.debug(
      `Broadcasted sales update: session_id=${sessionId}, count=${count}`,
    );
  }

  /**
   * Rejects a connection and disconnects the client
   */
  private rejectConnection(
    client: AuthenticatedSocket,
    message: string,
    code: string,
  ): void {
    this.logger.warn(`Connection rejected for client ${client.id}: ${message}`);

    client.emit('error', { message, code });
    client.disconnect();
  }

  /**
   * Joins user-specific rooms for targeted messaging
   */
  private joinUserRooms(
    client: AuthenticatedSocket,
    userInfo: AuthenticatedUser,
  ): void {
    void client.join(`user:${userInfo.userId}`);
    void client.join(`user:${userInfo.userUuid}`);
  }

  /**
   * Logs connection with optimized logging for high concurrency
   */
  private logConnection(
    client: AuthenticatedSocket,
    userInfo: AuthenticatedUser,
  ): void {
    if (this.connectionCount % 1000 === 0) {
      this.logger.log(
        `WebSocket connection milestone: ${this.connectionCount} total connections (authenticated)`,
      );
    } else {
      this.logger.debug(
        `Client connected: ${client.id}, userId: ${userInfo.userId}`,
      );
    }
  }
}

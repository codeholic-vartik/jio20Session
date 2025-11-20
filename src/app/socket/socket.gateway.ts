import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { JwtAuthService } from '../auth/jwt-auth.service';
import {
  AuthenticatedSocket,
  isAuthenticatedSocket,
} from '../auth/types/socket.types';
import type { AuthenticatedUser } from '../auth/jwt-auth.service';
import { SocketPingController } from './controllers/ping.controller';
import {
  SocketTaxonomyController,
  type TaxonomySalesJoinedPayload,
} from './controllers/taxonomy.controller';
import { SessionSalesPayloadDto } from './dto/session-sales.dto';
import {
  ERROR_MESSAGES,
  getSocketRoomKey,
  SOCKET_EVENTS,
  ERROR_CODES,
  KEYS,
} from './constants';
import { SalesUpdatePayload } from '../jobs/redis-subscriber.service';
import { calculateSalesPercentages } from './utils/sales-percentage.util';

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

  constructor(
    private readonly jwtAuthService: JwtAuthService,
    private readonly pingController: SocketPingController,
    private readonly taxonomyController: SocketTaxonomyController,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Extract token from socket handshake
      const token = this.jwtAuthService.extractTokenFromSocket(client);

      if (!token) {
        this.rejectConnection(
          client,
          ERROR_MESSAGES.AUTHENTICATION_REQUIRED,
          ERROR_CODES.AUTH_REQUIRED,
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
      client.emit(SOCKET_EVENTS.AUTHENTICATED, {
        userId: userInfo.userId,
        userUuid: userInfo.userUuid,
        message: 'Successfully authenticated',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : ERROR_MESSAGES.AUTHENTICATION_FAILED;
      this.rejectConnection(client, errorMessage, ERROR_CODES.AUTH_FAILED);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    const userId = client.user?.userId || 'unknown';
    this.logger.debug(`Client disconnected: ${client.id}, userId: ${userId}`);
  }

  @SubscribeMessage(SOCKET_EVENTS.PING)
  handlePing(@ConnectedSocket() client: Socket) {
    const authClient = client as AuthenticatedSocket;

    // Check authentication
    if (!isAuthenticatedSocket(authClient) || !authClient.user) {
      this.logger.warn(
        `Ping from unauthenticated client: socket_id=${client.id}`,
      );
      authClient.emit(SOCKET_EVENTS.ERROR, {
        message: ERROR_MESSAGES.AUTHENTICATION_REQUIRED,
        code: ERROR_CODES.AUTH_REQUIRED,
      });

      return;
    }

    const user = authClient.user;
    this.logger.debug(
      `Ping from authenticated user_id=${user.userId}, socket_id=${client.id}`,
    );

    const payload = this.pingController.buildPingPayload(user);

    // Emit event for clients listening via socket.on('pong')
    authClient.emit(SOCKET_EVENTS.PONG, payload);

    // Also return payload so Socket.IO ACK callbacks or REST-like clients
    // receive a non-empty JSON response
    return payload;
  }

  @SubscribeMessage(SOCKET_EVENTS.SESSION_SALES)
  async handleSessionSales(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SessionSalesPayloadDto | string,
  ): Promise<TaxonomySalesJoinedPayload | void> {
    const authClient = client as AuthenticatedSocket;
    // Check authentication
    if (!isAuthenticatedSocket(authClient) || !authClient.user) {
      authClient.emit(SOCKET_EVENTS.ERROR, {
        message: ERROR_MESSAGES.AUTHENTICATION_REQUIRED,
        code: ERROR_CODES.AUTH_REQUIRED,
      });
      this.logger.debug(`Authentication required`);
      return;
    }

    if (!payload) {
      authClient.emit(SOCKET_EVENTS.ERROR, {
        message: ERROR_MESSAGES.REQUEST_BODY_REQUIRED,
        code: ERROR_CODES.INVALID_REQUEST,
      });
      this.logger.debug('Session sales request missing payload');
      return;
    }

    // Deserialize payload if it's a string (DTO handles its own deserialization)
    const deserializedPayload = SessionSalesPayloadDto.deserialize(payload);

    this.logger.debug(
      `Session sales payload: ${JSON.stringify(deserializedPayload, null, 2)}`,
    );

    const { session_id, session_profile_id, taxonomy_term_id } =
      deserializedPayload;

    // Check if at least one identifier is provided
    if (!session_id && !session_profile_id && !taxonomy_term_id) {
      authClient.emit(SOCKET_EVENTS.ERROR, {
        message: ERROR_MESSAGES.IDENTIFIER_REQUIRED,
        code: ERROR_CODES.INVALID_REQUEST,
      });
      this.logger.debug(
        `Invalid request: session_id=${session_id}, session_profile_id=${session_profile_id}, taxonomy_term_id=${taxonomy_term_id}`,
      );
      return;
    }

    this.logger.debug(
      `Session sales requested: session_id=${session_id}, session_profile_id=${session_profile_id}, taxonomy_term_id=${taxonomy_term_id}`,
    );

    if (!taxonomy_term_id) {
      authClient.emit(SOCKET_EVENTS.ERROR, {
        message: ERROR_MESSAGES.TAXONOMY_TERM_ID_REQUIRED,
        code: ERROR_CODES.INVALID_REQUEST,
      });
      this.logger.debug('taxonomy_term_id is required for session sales data');
      return;
    }

    const response = await this.taxonomyController.buildJoinResponse(
      authClient,
      taxonomy_term_id,
    );

    this.logger.debug(
      `Session sales response: ${JSON.stringify(response, null, 2)}`,
    );

    const eventKey = getSocketRoomKey(
      'session',
      'sales',
      response.taxonomy_term.tmuid,
    );

    // Join the taxonomy sales room for real-time updates (same format as eventKey)
    await authClient.join(eventKey);

    this.logger.debug(
      `Client ${authClient.id} joined taxonomy sales room: ${eventKey}`,
    );

    // Emit initial response to the client
    authClient.emit(eventKey, response);

    // Also broadcast to user rooms (for other sessions of the same user)
    const userRooms = new Set<string>([
      KEYS.getUserRoom(authClient.user.userId),
      KEYS.getUserRoom(authClient.user.userUuid),
    ]);
    for (const room of userRooms) {
      authClient.to(room).emit(eventKey, response);
    }

    // Return the response to the client (Socket.IO ACK)
    return response;
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
    this.server.emit(SOCKET_EVENTS.PARTICIPANT_COUNT_UPDATE, payload);

    // Also broadcast to session-specific room (using suid)
    this.server
      .to(KEYS.getSessionRoom(suid))
      .emit(SOCKET_EVENTS.PARTICIPANT_COUNT_UPDATE, payload);

    // Only log at debug level to reduce overhead
    this.logger.debug(
      `Broadcasted participant update: suid=${suid}, count=${participantCount}`,
    );
  }

  /**
   * Broadcasts sales count update to all connected clients
   * Optimized for high concurrency (100k+ users)
   * Supports both session IDs (number) and taxonomy term IDs (string)
   */
  broadcastSalesCountUpdate(data: SalesUpdatePayload): void {
    // Calculate max_sales from sales_trigger_count
    const maxSales = data.sales_trigger_count || null;

    // Calculate percentage reached and left using utility function
    const { percentageSaleReached, percentageSaleLeft } =
      calculateSalesPercentages(data.count, maxSales);

    const payload = {
      ss: data.session_status,
      psr: percentageSaleReached,
      psl: percentageSaleLeft,
      sales_count: data.count,
      ca: new Date().toISOString(),
    };

    // Use the same room format that clients join and listen to
    const taxonomyRoom = getSocketRoomKey(
      'session',
      'sales',
      data.taxonomy_term_uid,
    );
    // Emit to the room with the same event name that clients listen to
    this.server.to(taxonomyRoom).emit(taxonomyRoom, payload);

    this.logger.debug(
      `Emitted to taxonomy room: ${taxonomyRoom} with event: ${taxonomyRoom}`,
    );

    // Only log at debug level to reduce overhead
    this.logger.debug(
      `Broadcasted sales update: taxonomy_term_uid=${data.taxonomy_term_uid}, session_status=${data.session_status}, percentage_sal_reached=${percentageSaleReached}, percentage_sale_left=${percentageSaleLeft}`,
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

    client.emit(SOCKET_EVENTS.ERROR, { message, code });
    client.disconnect();
  }

  /**
   * Joins user-specific rooms for targeted messaging
   */
  private joinUserRooms(
    client: AuthenticatedSocket,
    userInfo: AuthenticatedUser,
  ): void {
    void client.join(KEYS.getUserRoom(userInfo.userId));
    void client.join(KEYS.getUserRoom(userInfo.userUuid));
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

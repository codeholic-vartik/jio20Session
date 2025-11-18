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
import { DatabaseService } from '../../common/database/database.service';
import { SessionCounterService } from './realtime/session-counter.service';
import { JoinTaxonomySalesDto } from './dto/join-taxonomy-sales.dto';

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
    private readonly database: DatabaseService,
    private readonly sessionCounter: SessionCounterService,
  ) {}

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

    // Check authentication
    if (!isAuthenticatedSocket(authClient) || !authClient.user) {
      this.logger.warn(
        `Ping from unauthenticated client: socket_id=${client.id}`,
      );
      authClient.emit('error', {
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const user = authClient.user;
    this.logger.debug(
      `Ping from authenticated user_id=${user.userId}, socket_id=${client.id}`,
    );

    authClient.emit('pong', {
      timestamp: new Date().toISOString(),
      userId: user.userId,
    });
  }

  /**
   * Join a taxonomy term's sales updates channel
   * Returns current sales count, taxonomy term info, session profiles, and upcoming sessions
   */
  @SubscribeMessage('join:taxonomy:sales')
  async handleJoinTaxonomySales(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinTaxonomySalesDto,
  ): Promise<void> {
    const authClient = client as AuthenticatedSocket;
    if (!isAuthenticatedSocket(authClient) || !authClient.user) {
      authClient.emit('error', {
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    try {
      const { taxonomy_term_id } = data;

      this.logger.log(
        `Client ${authClient.id} requested taxonomy sales join for term=${taxonomy_term_id}`,
      );

      if (!taxonomy_term_id) {
        authClient.emit('error', {
          message: 'taxonomy_term_id is required',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      // Join the taxonomy-specific room
      const roomName = `taxonomy:sales:${taxonomy_term_id}`;
      await authClient.join(roomName);

      this.logger.debug(
        `Client ${authClient.id} joined taxonomy sales room: ${roomName}`,
      );

      // Fetch taxonomy term info
      const taxonomyTerm = await this.database.taxonomy_terms.findUnique({
        where: { tmuid: taxonomy_term_id },
        select: {
          id: true,
          tmuid: true,
          name: true,
          slug: true,
          description: true,
          is_active: true,
          taxonomy_id: true,
        },
      });

      if (!taxonomyTerm) {
        authClient.emit('error', {
          message: `Taxonomy term not found: ${taxonomy_term_id}`,
          code: 'TAXONOMY_NOT_FOUND',
        });
        return;
      }

      // Get session profiles linked to this taxonomy term
      const sessionTaxonomyTerms =
        await this.database.session_taxonomy_terms.findMany({
          where: {
            term_id: taxonomyTerm.id,
            is_enabled: true,
          },
          include: {
            session_profiles: {
              select: {
                id: true,
                spuid: true,
                title: true,
                description: true,
                max_slots: true,
                max_sessions: true,
                sales_trigger_count: true,
                is_active: true,
              },
            },
          },
        });

      const sessionProfiles = sessionTaxonomyTerms.map(
        (stt) => stt.session_profiles,
      );

      // Get current and upcoming sessions for these session profiles
      const sessionProfileIds = sessionProfiles.map((sp) => sp.id);
      const sessions =
        sessionProfileIds.length > 0
          ? await this.database.sessions.findMany({
              where: {
                session_profile_id: { in: sessionProfileIds },
                is_deleted: false,
                is_active: true,
                status: {
                  in: ['CURRENT', 'UPCOMING'],
                },
              },
              select: {
                id: true,
                suid: true,
                session_profile_id: true,
                name: true,
                start_time: true,
                end_time: true,
                status: true,
                current_sales_count: true,
                current_participant_count: true,
              },
              orderBy: [{ priority_position: 'asc' }, { start_time: 'asc' }],
            })
          : [];

      // Get current sales count from Redis (real-time counter)
      // This is the most up-to-date count from pub/sub updates
      let salesCount = await this.sessionCounter.getSalesCount(
        'taxonomy',
        taxonomy_term_id,
      );

      // If Redis doesn't have the count (returns 0), get from the upcoming session as fallback
      // There is only 1 upcoming session per session profile, so we use that session's count
      let salesCountSource: 'redis' | 'database' | 'none' =
        salesCount > 0 ? 'redis' : 'none';

      if (salesCount === 0 && sessions.length > 0) {
        // Get the first upcoming session's sales count (there's only 1 per profile)
        const upcomingSession =
          sessions.find((s) => s.status === 'UPCOMING') || sessions[0]; // Fallback to first session if no UPCOMING found

        const dbSalesCount = upcomingSession?.current_sales_count || 0;

        // If database has a count, use it and optionally sync to Redis
        if (dbSalesCount > 0) {
          salesCount = dbSalesCount;
          salesCountSource = 'database';
          // Optionally sync to Redis for future queries (non-blocking)
          this.sessionCounter
            .setSalesCount('taxonomy', taxonomy_term_id, dbSalesCount)
            .catch((err) => {
              this.logger.warn(
                `Failed to sync sales count to Redis: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }

      if (salesCountSource === 'none') {
        this.logger.warn(
          `Sales count unavailable for term=${taxonomy_term_id} (no Redis entry and no session fallback). Returning 0.`,
        );
      }

      this.logger.log(
        `Prepared taxonomy snapshot for term=${taxonomy_term_id}: sales_count=${salesCount} (source=${salesCountSource}), session_profiles=${sessionProfiles.length}, sessions=${sessions.length}`,
      );

      // Send initial data to client
      authClient.emit('taxonomy:sales:joined', {
        taxonomy_term: {
          id: taxonomyTerm.id,
          tmuid: taxonomyTerm.tmuid,
          name: taxonomyTerm.name,
          slug: taxonomyTerm.slug,
          description: taxonomyTerm.description,
          is_active: taxonomyTerm.is_active,
        },
        sales_count: salesCount,
        session_profiles: sessionProfiles,
        sessions: sessions.map((s) => ({
          id: s.id,
          suid: s.suid,
          session_profile_id: s.session_profile_id,
          name: s.name,
          start_time: s.start_time?.toISOString(),
          end_time: s.end_time?.toISOString(),
          status: s.status,
          current_sales_count: s.current_sales_count,
          current_participant_count: s.current_participant_count,
        })),
        joined_at: new Date().toISOString(),
      });

      this.logger.debug(
        `Sent taxonomy sales data to client ${authClient.id} for term ${taxonomy_term_id}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to join taxonomy sales';
      this.logger.error(
        `Error joining taxonomy sales: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      authClient.emit('error', {
        message: errorMessage,
        code: 'JOIN_ERROR',
      });
    }
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
   * Supports both session IDs (number) and taxonomy term IDs (string)
   */
  broadcastSalesCountUpdate(
    sessionId: number | string,
    count: number,
    sessionProfileId?: number,
  ): void {
    const payload: {
      session_id: number | string;
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

    // Broadcast to session-specific room (if numeric ID)
    if (typeof sessionId === 'number') {
      this.server
        .to(`session:${sessionId}`)
        .emit('sales:count:update', payload);
    }

    // Broadcast to taxonomy-specific room (if string ID like "ttm_...")
    if (typeof sessionId === 'string' && sessionId.startsWith('ttm_')) {
      this.server
        .to(`taxonomy:sales:${sessionId}`)
        .emit('sales:count:update', payload);
    }

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

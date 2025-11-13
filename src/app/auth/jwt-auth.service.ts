import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../../common/database/database.service';
import type { Socket } from 'socket.io';

export interface JwtPayload {
  sub: string | number; // user ID
  email?: string;
  uuid?: string;
  type?: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  jti?: string; // JWT ID for blacklisting
}

export interface AuthenticatedUser {
  userId: number;
  userUuid: string;
  email?: string;
  jti?: string;
}

@Injectable()
export class JwtAuthService {
  private readonly logger = new Logger(JwtAuthService.name);
  private readonly jwtSecret: string;
  private readonly jwtRefreshSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: DatabaseService,
    private readonly jwtService: JwtService,
  ) {
    this.jwtSecret =
      this.configService.get<string>('JWT_SECRET_KEY') ||
      'your-super-secret-jwt-key-change-this-in-production';
    this.jwtRefreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET_KEY') ||
      'your-super-secret-refresh-key-change-this-in-production';
  }

  /**
   * Validates JWT token and returns user information
   * @param token - JWT token string
   * @returns Authenticated user information
   * @throws UnauthorizedException if token is invalid, expired, or blacklisted
   */
  async validateToken(token: string): Promise<AuthenticatedUser> {
    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    // Remove 'Bearer ' prefix if present
    const cleanToken = token.replace(/^Bearer\s+/i, '');

    try {
      // Verify token with JWT secret using NestJS JwtService
      let decoded: JwtPayload;
      try {
        decoded = this.jwtService.verify<JwtPayload>(cleanToken, {
          secret: this.jwtSecret,
        });
      } catch (err: unknown) {
        // If access token fails, it might be a refresh token (don't accept it)
        if (err instanceof Error) {
          if (err.name === 'JsonWebTokenError') {
            throw new UnauthorizedException('Invalid token');
          }
          if (err.name === 'TokenExpiredError') {
            throw new UnauthorizedException('Token has expired');
          }
        }
        throw new UnauthorizedException('Invalid or expired token');
      }

      // Check if token is blacklisted (frontend users use frontend_token_blacklist)
      if (decoded.jti) {
        const blacklisted =
          await this.prisma.frontend_token_blacklist.findUnique({
            where: { jti: decoded.jti },
          });

        if (blacklisted) {
          this.logger.warn(`Blacklisted token used: ${decoded.jti}`);
          throw new UnauthorizedException('Token has been revoked');
        }
      }

      // Extract user ID (sub can be number or string)
      const userId =
        typeof decoded.sub === 'number'
          ? decoded.sub
          : parseInt(String(decoded.sub), 10);

      if (isNaN(userId)) {
        throw new UnauthorizedException('Invalid user ID in token');
      }

      // Verify user exists in frontendusers table
      const user = await this.prisma.frontendusers.findUnique({
        where: { id: userId },
        select: {
          id: true,
          uuid: true,
          email: true,
          is_blocked: true,
          blocked_until: true,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Check if user is blocked
      if (user.is_blocked) {
        if (user.blocked_until && user.blocked_until > new Date()) {
          throw new UnauthorizedException(
            'User account is temporarily blocked',
          );
        }
      }

      return {
        userId: user.id,
        userUuid: user.uuid,
        email: user.email || undefined,
        jti: decoded.jti,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.error(
        `JWT validation error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Invalid authentication token');
    }
  }

  /**
   * Extracts token from Socket.IO handshake auth or query parameters
   * @param socket - Socket.IO socket instance
   * @returns Token string or null
   */
  extractTokenFromSocket(socket: Socket): string | null {
    // Check auth object (recommended for Socket.IO v4+)
    const authToken: unknown = socket.handshake?.auth?.token;
    if (typeof authToken === 'string') {
      return authToken;
    }

    // Check Authorization header
    const authHeader = socket.handshake?.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
      return authHeader;
    }

    // Check query parameters (fallback, less secure)
    // Query params can be string or string array, handle both
    const queryTokenRaw = socket.handshake?.query?.token;
    if (queryTokenRaw) {
      const queryToken = Array.isArray(queryTokenRaw)
        ? queryTokenRaw[0]
        : queryTokenRaw;
      if (typeof queryToken === 'string') {
        return queryToken;
      }
    }

    return null;
  }
}

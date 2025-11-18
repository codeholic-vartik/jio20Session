import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../../common/database/database.service';
import type { Socket } from 'socket.io';
import type { Prisma } from '@prisma/client';

export interface JwtPayload {
  sub: string | number; // user ID
  email?: string;
  uuid?: string;
  user_id?: string; // external user identifier (string)
  type?: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  jti?: string; // JWT ID for blacklisting
}

export interface AuthenticatedUser {
  userId: number;
  userUuid: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phoneNumber?: string | null;
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

        // Emit structured debug log so we can inspect payload without exposing the raw token
        const jwtPayload = {
          jwtPayload: decoded,
          rawToken: cleanToken,
        };
        this.logger.debug(`Decoded JWT payload: ${JSON.stringify(jwtPayload)}`);
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

      // Determine how to look up the user (supports id, uuid, or external user_id claim)
      const parsedUserId =
        typeof decoded.sub === 'number'
          ? decoded.sub
          : Number.parseInt(String(decoded.sub), 10);

      const candidateUuid =
        (typeof decoded.user_id === 'string' &&
        decoded.user_id.trim().length > 0
          ? decoded.user_id.trim()
          : undefined) ||
        (typeof decoded.uuid === 'string' && decoded.uuid.trim().length > 0
          ? decoded.uuid.trim()
          : undefined) ||
        (typeof decoded.sub === 'string' && Number.isNaN(parsedUserId)
          ? decoded.sub.trim()
          : undefined);

      let lookupField: 'id' | 'uuid' = 'id';
      let lookupValue: number | string = parsedUserId;

      if (Number.isNaN(parsedUserId) || parsedUserId <= 0) {
        if (!candidateUuid) {
          this.logger.warn('Token missing valid user identifier (id or uuid)');
          throw new UnauthorizedException('Invalid user identifier in token');
        }

        lookupField = 'uuid';
        lookupValue = candidateUuid;
      }

      const userWhere: Prisma.frontendusersWhereUniqueInput =
        lookupField === 'id'
          ? { id: lookupValue as number }
          : { uuid: lookupValue as string };

      const user = await this.prisma.frontendusers.findUnique({
        where: userWhere,
        select: {
          id: true,
          uuid: true,
          email: true,
          first_name: true,
          last_name: true,
          username: true,
          phone_number: true,
          is_blocked: true,
          blocked_until: true,
          is_active: true,
          is_deleted: true,
        },
      });

      if (!user) {
        this.logger.warn(
          `User lookup failed for ${lookupField}=${lookupValue}`,
        );
        throw new UnauthorizedException('User not found');
      }

      // Check if user is active / not deleted
      if (user.is_active === false) {
        throw new UnauthorizedException('User account is inactive');
      }

      if (user.is_deleted === true) {
        throw new UnauthorizedException('User account has been deleted');
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
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        phoneNumber: user.phone_number,
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

    // Check Authorization header (supports "Bearer TOKEN" or just "TOKEN")
    const authHeader = socket.handshake?.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
      // Extract token from "Bearer TOKEN" format
      if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7); // Remove "Bearer " prefix
      }
      return authHeader; // Return as-is if no Bearer prefix
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

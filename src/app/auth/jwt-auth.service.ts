import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../../common/database/database.service';
import type { Socket } from 'socket.io';
import type { Prisma, frontend_token_blacklist } from '@prisma/client';

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
      // First check by JTI (JWT ID) - most efficient and recommended
      let blacklisted: frontend_token_blacklist | null = null;
      if (decoded.jti) {
        blacklisted = await this.prisma.frontend_token_blacklist.findUnique({
          where: { jti: decoded.jti },
        });
      }

      // Fallback: If no JTI or not found by JTI, check by token string itself
      if (!blacklisted) {
        blacklisted = await this.prisma.frontend_token_blacklist.findFirst({
          where: { token: cleanToken },
        });
      }

      if (blacklisted) {
        // Check if blacklist entry has expired (cleanup old entries)
        if (blacklisted.expires_at && blacklisted.expires_at < new Date()) {
          this.logger.debug(
            `Blacklist entry expired for jti=${blacklisted.jti}, skipping check`,
          );
        } else {
          this.logger.warn(
            `Blacklisted token used: jti=${blacklisted.jti || 'N/A'}, reason=${blacklisted.reason || 'N/A'}`,
          );
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
    // Priority 1: Check auth object
    const authToken: unknown = socket.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken.trim().length > 0) {
      this.logger.debug('Token extracted from auth.token');
      return authToken.trim();
    }

    // Also check other auth object properties (some clients may use different keys)
    const auth = socket.handshake?.auth;
    if (auth && typeof auth === 'object' && auth !== null) {
      // Check common auth object variations
      const authKeys = [
        'access_token',
        'accessToken',
        'jwt',
        'jwtToken',
        'bearer',
      ];
      for (const key of authKeys) {
        const value = (auth as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) {
          this.logger.debug(`Token extracted from auth.${key}`);
          return value.trim();
        }
      }
    }

    // Priority 2: Check Authorization header (case-insensitive)
    const headers = socket.handshake?.headers || {};

    // Check multiple header name variations (case-insensitive)
    // Some clients/proxies send "auth" instead of "authorization"
    const authHeaderKeys = [
      'authorization',
      'Authorization',
      'AUTHORIZATION',
      'auth',
      'Auth',
      'AUTH',
    ];
    for (const headerKey of authHeaderKeys) {
      const authHeader = headers[headerKey as keyof typeof headers];
      if (authHeader && typeof authHeader === 'string') {
        let token = authHeader.trim();

        // Extract token from "Bearer TOKEN" format
        if (token.startsWith('Bearer ') || token.startsWith('bearer ')) {
          token = token.substring(7).trim();
        }

        if (token.length > 0) {
          this.logger.debug(`Token extracted from header.${headerKey}`);
          return token;
        }
      }
    }

    // Also check all headers for any token-like values (last resort)
    // Some proxies/clients may send tokens in custom headers
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      if (
        headerValue &&
        typeof headerValue === 'string' &&
        headerValue.trim().length > 20 && // Tokens are usually long
        !['host', 'user-agent', 'accept', 'connection'].includes(
          headerKey.toLowerCase(),
        )
      ) {
        let token = headerValue.trim();
        // Remove Bearer prefix if present
        if (token.startsWith('Bearer ') || token.startsWith('bearer ')) {
          token = token.substring(7).trim();
        }
        // Basic JWT token validation (contains dots and is reasonably long)
        if (
          token.length > 20 &&
          token.includes('.') &&
          token.split('.').length === 3
        ) {
          this.logger.debug(`Token extracted from header.${headerKey}`);
          return token;
        }
      }
    }

    // Priority 3: Check query parameters (fallback)
    // Query params can be string or string array, handle both
    const query = socket.handshake?.query || {};
    const queryTokenKeys = [
      'token',
      'access_token',
      'accessToken',
      'jwt',
      'jwtToken',
      't', // Some clients use abbreviated key
    ];

    for (const queryKey of queryTokenKeys) {
      const queryTokenRaw = query[queryKey];
      if (queryTokenRaw) {
        const queryToken = Array.isArray(queryTokenRaw)
          ? queryTokenRaw[0]
          : queryTokenRaw;
        if (typeof queryToken === 'string' && queryToken.trim().length > 0) {
          this.logger.debug(`Token extracted from query.${queryKey}`);
          return queryToken.trim();
        }
      }
    }

    // No token found - enhanced debugging
    const headerKeys = Object.keys(headers);
    const queryKeys = Object.keys(query);
    this.logger.warn(
      `No authentication token found in socket handshake. Client: ${socket.id}, ` +
        `Auth keys: ${auth ? Object.keys(auth).join(', ') : 'none'}, ` +
        `Header keys: ${headerKeys.join(', ')}, ` +
        `Query keys: ${queryKeys.join(', ')}`,
    );
    // Debug: log first few chars of potentially token-containing values
    if (headers.auth && typeof headers.auth === 'string') {
      this.logger.debug(
        `Header 'auth' contains: ${headers.auth.substring(0, 20)}...`,
      );
    }
    if (query.t && typeof query.t === 'string') {
      this.logger.debug(`Query 't' contains: ${query.t.substring(0, 20)}...`);
    }
    return null;
  }
}

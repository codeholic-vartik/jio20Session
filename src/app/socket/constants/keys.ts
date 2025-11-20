type SocketRoomType = 'session' | 'taxonomy' | 'ping' | 'pong' | 'error';
type SocketRoomSubType = 'sales' | 'participant' | 'threshold';

export const getSocketRoomKey = (
  type: SocketRoomType,
  subType?: SocketRoomSubType,
  id?: string,
): string => `${type}:${subType ? `${subType}:` : ''}${id ? `${id}` : ''}`;

/**
 * Socket event names for client-server communication
 */
export const SOCKET_EVENTS = {
  // Client -> Server (SubscribeMessage)
  PING: 'ping',
  SESSION_SALES: 'session:sales:count',
  JOIN_TAXONOMY_SALES: 'join:taxonomy:sales',

  // Server -> Client (emit)
  AUTHENTICATED: 'authenticated',
  PONG: 'pong',
  ERROR: 'error',
  PARTICIPANT_COUNT_UPDATE: 'participant:count:update',
  SALES_COUNT_UPDATE: 'sales:count:update',
  TAXONOMY_SALES_JOINED: 'taxonomy:sales:joined',
} as const;

/**
 * Error codes for socket error responses
 */
export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TAXONOMY_NOT_FOUND: 'TAXONOMY_NOT_FOUND',
  JOIN_ERROR: 'JOIN_ERROR',
} as const;

/**
 * Error messages for socket error responses
 */
export const ERROR_MESSAGES = {
  AUTHENTICATION_REQUIRED: 'Authentication required',
  AUTHENTICATION_FAILED: 'Authentication failed',
  REQUEST_BODY_REQUIRED: 'Request body is required',
  IDENTIFIER_REQUIRED:
    'Provide at least one of session_id, session_profile_id, or taxonomy_term_id',
  TAXONOMY_TERM_ID_REQUIRED: 'taxonomy_term_id is required',
  FAILED_TO_JOIN_TAXONOMY_SALES: 'Failed to join taxonomy sales',
} as const;

/**
 * Room name patterns and builders
 */
export const KEYS = {
  /**
   * Get session room name by session ID
   */
  getSessionRoom: (sessionId: number | string): string =>
    `session:${sessionId}`,

  /**
   * Get taxonomy sales room name by taxonomy term ID
   */
  getTaxonomySalesRoom: (taxonomyTermId: string): string =>
    `taxonomy:sales:${taxonomyTermId}`,

  /**
   * Get user room name by user ID
   */
  getUserRoom: (userId: number | string): string => `user:${userId}`,

  /**
   * Get session sales redis key by session ID
   */
  getSessionSalesRedisKey: (sessionId: string): string =>
    `session:sales:${sessionId}`,
} as const;

/**
 * Redis channel names for session events
 */
export const REDIS_CHANNELS = {
  SALES_UPDATE: 'session:sales:update',
  PARTICIPANT_UPDATE_PATTERN: 'session:participant:*',
  THRESHOLD_REACHED: 'session:sales:threshold_reached',
  TAXONOMY_SALES_UPDATE: 'taxonomy:sales:update',
} as const;

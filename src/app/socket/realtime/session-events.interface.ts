/**
 * @fileoverview Session real-time event interfaces
 * @description Type definitions for Redis pub/sub event payloads
 */

/**
 * Payload structure for sales count update events from Redis pub/sub
 */
export interface SalesCountUpdatePayload {
  session_id: number | string;
  count: number;
  session_profile_id?: number | string;
  taxonomy_term_id?: number | string;
  type?: 'session' | 'taxonomy';
  created_at?: string;
}

/**
 * Payload structure for participant count update events from Redis pub/sub
 */
export interface ParticipantCountUpdatePayload {
  suid: string;
  participant_count: number;
  session_profile_id: number;
  session_id?: number;
  position?: number;
  is_winner?: boolean;
  created_at?: string;
}

/**
 * Payload structure for threshold reached events from Redis pub/sub
 */
export interface ThresholdReachedPayload {
  session_id: number | string;
  count: number;
  session_profile_id: number | string;
  created_at?: string;
}

/**
 * Payload structure for generic session events from Redis pub/sub
 */
export interface SessionEventPayload {
  session_id: number;
  session_profile_id: number;
  event_type: string;
  data?: Record<string, unknown>;
  created_at?: string;
}

/**
 * Type for Redis channel names
 */
export type RedisChannelName =
  | 'session:sales:update'
  | 'session:participant:*'
  | 'session:sales:threshold_reached'
  | 'taxonomy:sales:update';

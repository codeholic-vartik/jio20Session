export const getSessionSalesCountKey = (
  type: 'session' | 'taxonomy',
  id: string,
) => `${type}:sales:${id}`;

/**
 * Redis channel names for session events
 */
export const REDIS_CHANNELS = {
  SALES_UPDATE: 'session:sales:update',
  PARTICIPANT_UPDATE_PATTERN: 'session:participant:*',
  THRESHOLD_REACHED: 'session:sales:threshold_reached',
  TAXONOMY_SALES_UPDATE: 'taxonomy:sales:update',
} as const;

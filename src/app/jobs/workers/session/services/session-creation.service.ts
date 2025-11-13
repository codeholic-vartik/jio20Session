/**
 * @fileoverview Session creation service
 * @description Handles the business logic for creating new sessions when thresholds are reached
 */

import { PrismaClient } from '@prisma/client';
import { generateUid } from '../../../../../common/utils/uuid.util';
import { generateSessionName } from '../../../../../common/utils/session.util';
import { SessionStatus } from '../../../../../common/types/enums';
import { calculateEndTime } from '../utils/session.util';

const prisma = new PrismaClient();

/**
 * Creates a new session when threshold is reached
 *
 * @description
 * This function handles the complete session creation process:
 * 1. Validates session profile exists and is active
 * 2. Validates existing session (if provided) belongs to profile
 * 3. Updates existing session status to OPENING if needed
 * 4. Checks max_sessions limit
 * 5. Creates new session with calculated start/end times
 * 6. Updates session profile's session count
 *
 * @param {number} sessionId - The existing session ID that triggered the creation (optional)
 * @param {number} sessionProfileId - The session profile ID to create session for
 * @returns {Promise<Object>} Result object with success status and new session ID
 * @returns {boolean} returns.success - Whether creation was successful
 * @returns {string} returns.message - Success message
 * @returns {number} [returns.newSessionId] - ID of the newly created session
 *
 * @throws {Error} If session profile not found, inactive, or deleted
 * @throws {Error} If existing session not found or doesn't belong to profile
 * @throws {Error} If maximum sessions limit reached
 *
 * @example
 * ```typescript
 * try {
 *   const result = await createSession(123, 456);
 *   console.log(`New session created: ${result.newSessionId}`);
 * } catch (error) {
 *   console.error('Failed to create session:', error.message);
 * }
 * ```
 */
export async function createSession(
  sessionId: number,
  sessionProfileId: number,
): Promise<{ success: boolean; message: string; newSessionId?: number }> {
  // Fetch session profile - must be active and not deleted
  const sessionProfile = await prisma.session_profiles.findFirst({
    where: {
      id: sessionProfileId,
      is_active: true,
      is_deleted: false,
    },
  });

  if (!sessionProfile) {
    throw new Error(
      `Session profile not found, inactive, or deleted: ${sessionProfileId}`,
    );
  }

  // Validate and update existing session if sessionId is provided
  if (sessionId) {
    const existingSession = await prisma.sessions.findUnique({
      where: { id: sessionId },
    });

    if (!existingSession) {
      throw new Error(`Existing session not found: ${sessionId}`);
    }

    // Verify session belongs to the profile
    if (existingSession.session_profile_id !== sessionProfileId) {
      throw new Error(
        `Session ${sessionId} does not belong to profile ${sessionProfileId}`,
      );
    }

    // Update session status from UPCOMING to OPENING if applicable
    if (existingSession.status === SessionStatus.UPCOMING.valueOf()) {
      await prisma.sessions.update({
        where: { id: sessionId },
        data: { status: SessionStatus.OPENING },
      });
    }
  }

  // Check max_sessions limit
  if (
    sessionProfile.max_sessions !== null &&
    sessionProfile.sessions_count >= sessionProfile.max_sessions
  ) {
    throw new Error('Maximum sessions limit reached for this profile');
  }

  // Calculate start and end times
  const startTime = new Date();
  const endTime = calculateEndTime(
    startTime,
    sessionProfile.session_duration_value,
    sessionProfile.session_duration_unit,
  );

  // Generate unique session ID
  const suid = generateUid('ssn_');

  // Create new session
  const sessionNumber = sessionProfile.sessions_count + 1;
  const sessionName = generateSessionName(sessionProfile.title, sessionNumber);

  // New sessions always start with 0 sales count
  // sales_trigger_count is the threshold/limit per session, not an initial count
  const initialSalesCount = 0;

  const newSession = await prisma.sessions.create({
    data: {
      suid,
      session_profile_id: sessionProfileId,
      name: sessionName,
      start_time: startTime,
      end_time: endTime,
      status: SessionStatus.UPCOMING,
      priority_position: sessionProfile.priority_position,
      is_active: true,
      is_deleted: false,
      current_sales_count: initialSalesCount,
      current_participant_count: 0,
      auto_close_on_full: true,
    },
  });

  // Update session profile sessions_count
  await prisma.session_profiles.update({
    where: { id: sessionProfileId },
    data: {
      sessions_count: {
        increment: 1,
      },
    },
  });

  return {
    success: true,
    message: `Session created successfully for profile ${sessionProfileId}`,
    newSessionId: newSession.id,
  };
}

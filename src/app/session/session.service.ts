import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { generateUid } from '../../common/utils/uuid.util';
import { generateSessionName } from '../../common/utils/session.util';
import { SessionStatus } from '../../common/types/enums';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly prisma: DatabaseService) {}

  async getActiveSessions() {
    return this.prisma.sessions.findMany({
      where: { is_active: true },
      take: 100,
    });
  }

  /**
   * Calculates end time based on duration from profile
   */
  private calculateEndTime(
    startTime: Date,
    durationValue: number | null,
    durationUnit: string | null,
  ): Date | null {
    if (!durationValue || !durationUnit) {
      return null;
    }

    const endTime = new Date(startTime);
    switch (durationUnit.toLowerCase()) {
      case 'hours':
        endTime.setHours(endTime.getHours() + durationValue);
        break;
      case 'minutes':
        endTime.setMinutes(endTime.getMinutes() + durationValue);
        break;
      case 'days':
        endTime.setDate(endTime.getDate() + durationValue);
        break;
      default:
        return null;
    }
    return endTime;
  }

  /**
   * Creates a new session when threshold is reached.
   * Automatically creates a session based on the session profile configuration.
   *
   * @param sessionId - The existing session ID that reached threshold
   * @param sessionProfileId - The session profile ID associated with the session
   * @returns Promise with session creation result
   */
  async createSession(
    sessionId: number,
    sessionProfileId: number,
  ): Promise<{ success: boolean; message: string; newSessionId?: number }> {
    this.logger.log(
      `Creating session for session_id=${sessionId}, session_profile_id=${sessionProfileId}`,
    );

    // Fetch session profile - use findUnique for better performance with primary key
    const sessionProfile = await this.prisma.session_profiles.findUnique({
      where: {
        id: sessionProfileId,
        is_active: true,
        is_deleted: false,
      },
    });

    if (!sessionProfile) {
      throw new Error(`Session profile not found: ${sessionProfileId}`);
    }

    // Validate session profile is active and not deleted
    if (!sessionProfile.is_active || sessionProfile.is_deleted) {
      throw new Error(
        `Session profile is inactive or deleted: ${sessionProfileId}`,
      );
    }

    // Validate and update existing session if sessionId is provided
    if (sessionId) {
      const existingSession = await this.prisma.sessions.findUnique({
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
        await this.prisma.sessions.update({
          where: { id: sessionId },
          data: { status: SessionStatus.OPENING },
        });
        this.logger.log(
          `Updated session ${sessionId} status to OPENING for profile ${sessionProfileId}`,
        );
      }
    }

    // Check max_sessions limit
    if (
      sessionProfile.max_sessions !== null &&
      sessionProfile.sessions_count >= sessionProfile.max_sessions
    ) {
      this.logger.warn(
        `Max sessions limit reached for profile ${sessionProfileId}. Current: ${sessionProfile.sessions_count}, Max: ${sessionProfile.max_sessions}`,
      );
      throw new Error('Maximum sessions limit reached for this profile');
    }

    // Calculate start and end times
    const startTime = new Date();
    const endTime = this.calculateEndTime(
      startTime,
      sessionProfile.session_duration_value,
      sessionProfile.session_duration_unit,
    );

    // Generate unique session ID
    const suid = generateUid('ssn_');

    // Create new session
    const sessionNumber = sessionProfile.sessions_count + 1;
    const sessionName = generateSessionName(
      sessionProfile.title,
      sessionNumber,
    );

    const newSession = await this.prisma.sessions.create({
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
        current_sales_count: 0,
        current_participant_count: 0,
        auto_close_on_full: true,
      },
    });

    // Update session profile sessions_count
    await this.prisma.session_profiles.update({
      where: { id: sessionProfileId },
      data: {
        sessions_count: {
          increment: 1,
        },
      },
    });

    this.logger.log(
      `Session created successfully: new_session_id=${newSession.id}, suid=${suid}`,
    );

    return {
      success: true,
      message: `Session created successfully for profile ${sessionProfileId}`,
      newSessionId: newSession.id,
    };
  }
}

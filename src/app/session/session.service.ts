import { Injectable, Logger, Inject } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { generateUid } from '../../common/utils/uuid.util';
import { generateSessionName } from '../../common/utils/session.util';
import { SessionStatus } from '../../common/types/enums';
import IORedis from 'ioredis';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: DatabaseService,
    @Inject('BULLMQ_CONNECTION') private readonly redis: IORedis,
  ) {}

  async getActiveSessions() {
    return this.prisma.sessions.findMany({
      where: { is_active: true },
      take: 100,
    });
  }

  /**
   * Calculates end time based on duration from profile
   * Supports: seconds, minutes, hours, days, years
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
      case 'seconds':
        endTime.setSeconds(endTime.getSeconds() + durationValue);
        break;
      case 'minutes':
        endTime.setMinutes(endTime.getMinutes() + durationValue);
        break;
      case 'hours':
        endTime.setHours(endTime.getHours() + durationValue);
        break;
      case 'days':
        endTime.setDate(endTime.getDate() + durationValue);
        break;
      case 'years':
        endTime.setFullYear(endTime.getFullYear() + durationValue);
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

    // Fetch session profile - must be active and not deleted
    const sessionProfile = await this.prisma.session_profiles.findFirst({
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
    const currentTime = new Date();
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

      // Update previous session: set start_time to current time and change status from UPCOMING to OPENING
      if (existingSession.status === SessionStatus.UPCOMING.valueOf()) {
        await this.prisma.sessions.update({
          where: { id: sessionId },
          data: {
            status: SessionStatus.OPENING,
            start_time: currentTime,
            start_trigger_type: sessionProfile.session_duration_unit,
            start_trigger_value: sessionProfile.session_duration_value,
          },
        });
        this.logger.log(
          `Updated session ${sessionId} status to OPENING and set start_time to current time for profile ${sessionProfileId}`,
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

    // Calculate start and end times for new session based on profile duration
    // const startTime = new Date();
    // const endTime = this.calculateEndTime(
    //   startTime,
    //   sessionProfile.session_duration_value,
    //   sessionProfile.session_duration_unit,
    // );

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

    // NOTE: We do NOT delete the old session's Redis sales key here
    // The sync job will handle syncing those sales to DB and then deleting the key
    // This ensures no sales data is lost if sync hasn't run yet

    this.logger.log(
      `Session created successfully: new_session_id=${newSession.id}, suid=${suid}`,
    );

    return {
      success: true,
      message: `Session created successfully for profile ${sessionProfileId}`,
      newSessionId: newSession.id,
    };
  }

  /**
   * Disables sales for all taxonomy terms related to a session profile.
   * Sets is_enabled = false in session_taxonomy_terms and Redis flags.
   * Publishes real-time updates to Redis pub/sub channel sales:term:{termId}
   *
   * @param sessionProfileId - The session profile ID
   */
  async disableSalesForProfile(sessionProfileId: number): Promise<void> {
    try {
      // Get session profile to calculate sales limits
      const sessionProfile = await this.prisma.session_profiles.findUnique({
        where: { id: sessionProfileId },
        select: {
          max_sessions: true,
          sales_trigger_count: true,
        },
      });

      if (!sessionProfile) {
        this.logger.warn(
          `Session profile ${sessionProfileId} not found for sales disable`,
        );
        return;
      }

      // Get all taxonomy terms related to this profile
      const sessionTaxonomyTerms =
        await this.prisma.session_taxonomy_terms.findMany({
          where: {
            session_profile_id: sessionProfileId,
            is_enabled: true, // Only disable currently enabled ones
          },
          select: {
            term_id: true,
          },
        });

      if (sessionTaxonomyTerms.length === 0) {
        this.logger.log(
          `No enabled taxonomy terms found for profile ${sessionProfileId}`,
        );
        return;
      }

      // Calculate total max sales per term = max_sessions * sales_trigger_count
      const salesTriggerCount = sessionProfile.sales_trigger_count || 0;
      const totalMaxSalesPerTerm =
        sessionProfile.max_sessions && salesTriggerCount
          ? sessionProfile.max_sessions * salesTriggerCount
          : 0;

      // Calculate current total sales for all sessions of this profile
      const allProfileSessions = await this.prisma.sessions.findMany({
        where: {
          session_profile_id: sessionProfileId,
          is_deleted: false,
        },
        select: {
          current_sales_count: true,
        },
      });

      const currentTotalSales = allProfileSessions.reduce(
        (sum, session) => sum + (session.current_sales_count || 0),
        0,
      );

      // Calculate remaining sales per term
      const remainingSales = Math.max(
        0,
        totalMaxSalesPerTerm - currentTotalSales,
      );

      // Disable in database
      await this.prisma.session_taxonomy_terms.updateMany({
        where: {
          session_profile_id: sessionProfileId,
          is_enabled: true,
        },
        data: {
          is_enabled: false,
        },
      });

      // Set Redis flags for fast checks and publish sales threshold updates
      const redisPromises = sessionTaxonomyTerms.map((term) => {
        const redisKey = `taxonomy:${term.term_id}:sales_disabled`;
        const channel = `session:sales:term:${term.term_id}`;
        const payload = JSON.stringify({
          term_id: term.term_id,
          remaining_sales: remainingSales,
          total_max_sales: totalMaxSalesPerTerm,
          current_sales: currentTotalSales,
          max_sessions: sessionProfile.max_sessions,
          sales_trigger_count: salesTriggerCount,
          profile_id: sessionProfileId,
          threshold_reached: true,
          timestamp: new Date().toISOString(),
        });

        return Promise.all([
          this.redis.setex(redisKey, 2592000, '1'), // 30 days TTL
          this.redis.publish(channel, payload), // Publish to pub/sub channel
        ]);
      });

      await Promise.all(redisPromises);

      this.logger.log(
        `Disabled sales for ${sessionTaxonomyTerms.length} taxonomy terms for profile ${sessionProfileId}. Remaining sales: ${remainingSales} (Total max: ${totalMaxSalesPerTerm}, Current: ${currentTotalSales})`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to disable sales for profile ${sessionProfileId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      // Don't throw - allow session creation to succeed even if disable fails
    }
  }

  /**
   * Checks if sales are enabled for a taxonomy term.
   * Checks Redis first (fast), then falls back to database.
   *
   * @param termId - The taxonomy term ID
   * @returns true if sales are enabled, false otherwise
   */
  async isSalesEnabled(termId: number): Promise<boolean> {
    try {
      // Check Redis first (fast path)
      const redisKey = `taxonomy:${termId}:sales_disabled`;
      const redisValue = await this.redis.get(redisKey);
      if (redisValue === '1') {
        return false; // Sales disabled
      }

      // Fallback to database check
      const sessionTerm = await this.prisma.session_taxonomy_terms.findFirst({
        where: {
          term_id: termId,
          is_enabled: true,
        },
      });

      return sessionTerm !== null;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to check sales status for term ${termId}: ${errorMessage}`,
      );
      // On error, default to enabled (fail open)
      return true;
    }
  }
}

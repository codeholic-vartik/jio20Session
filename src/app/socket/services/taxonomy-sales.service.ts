import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../common/database/database.service';
import { SessionCounterService } from './session-counter.service';
import { SessionStatus } from 'src/common/types/enums';

export interface TaxonomySalesSnapshot {
  taxonomy_term: {
    title: string;
    description: string;
    tmuid: string;
  };
  sales_count: number;
  session_profiles: Array<{
    title: string;
    description: string;
    spuid: string;
    is_active: boolean;
    max_slots: number | null;
    sales_trigger_count: number | null;
    max_sessions: number | null;
  }>;
  sessions: Array<{
    suid: string;
    title: string;
    description: string;
    status: SessionStatus;
    current_sales_count: number;
    current_participant_count: number;
  }>;
}

@Injectable()
export class TaxonomySalesService {
  private readonly logger = new Logger(TaxonomySalesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sessionCounter: SessionCounterService,
  ) {}

  async buildSalesSnapshot(
    taxonomyTermUid: string,
  ): Promise<TaxonomySalesSnapshot> {
    // Get taxonomy term by tmuid
    const taxonomyTerm = await this.database.taxonomy_terms.findUnique({
      where: { tmuid: taxonomyTermUid, is_active: true },
      select: {
        id: true,
        tmuid: true,
        name: true,
        description: true,
      },
    });

    if (!taxonomyTerm) {
      this.logger.error(`Taxonomy term not found: ${taxonomyTermUid}`);
      throw new NotFoundException(
        `Taxonomy term not found: ${taxonomyTermUid}`,
      );
    }

    // Get all enabled session_taxonomy_terms for this taxonomy term
    // with active and non-deleted session profiles
    const sessionTaxonomyTerms =
      await this.database.session_taxonomy_terms.findMany({
        where: {
          term_id: taxonomyTerm.id,
          is_enabled: true,
          session_profiles: {
            is_active: true,
            is_deleted: false,
          },
        },
        include: {
          session_profiles: {
            select: {
              id: true,
              spuid: true,
              title: true,
              description: true,
              is_active: true,
              max_slots: true,
              sales_trigger_count: true,
              max_sessions: true,
            },
          },
        },
      });

    if (sessionTaxonomyTerms.length === 0) {
      this.logger.debug(
        `No enabled session taxonomy terms found for: ${taxonomyTermUid}`,
      );
      return {
        taxonomy_term: {
          title: taxonomyTerm.name ?? '',
          description: taxonomyTerm.description ?? '',
          tmuid: taxonomyTerm.tmuid,
        },
        sales_count: 0,
        session_profiles: [],
        sessions: [],
      };
    }

    // Extract unique session profiles (deduplicate by id)
    const sessionProfilesMap = new Map<
      number,
      (typeof sessionTaxonomyTerms)[0]['session_profiles']
    >();
    for (const stt of sessionTaxonomyTerms) {
      if (!sessionProfilesMap.has(stt.session_profiles.id)) {
        sessionProfilesMap.set(stt.session_profiles.id, stt.session_profiles);
      }
    }
    const sessionProfiles = Array.from(sessionProfilesMap.values());
    const sessionProfileIds = sessionProfiles.map((sp) => sp.id);

    // Get all upcoming sessions for these session profiles in a single optimized query
    const sessions = await this.database.sessions.findMany({
      where: {
        session_profile_id: { in: sessionProfileIds },
        is_deleted: false,
        is_active: true,
        status: SessionStatus.UPCOMING,
      },
      select: {
        id: true,
        suid: true,
        session_profile_id: true,
        name: true,
        status: true,
        current_sales_count: true,
        current_participant_count: true,
        priority_position: true,
      },
      orderBy: [
        { session_profile_id: 'asc' }, // needed for distinct
        { priority_position: 'asc' }, // pick highest priority
        { start_time: 'asc' }, // earliest session
      ],
      distinct: ['session_profile_id'],
    });

    this.logger.debug(`Sessions: ${JSON.stringify(sessions, null, 2)}`);

    const activeSession = sessions[0];
    let salesCount = 0;

    if (activeSession) {
      salesCount = await this.sessionCounter.getSalesCount(
        'session',
        activeSession.id,
      );
      this.logger.debug(
        `Sales count for session ${activeSession.suid} (taxonomy ${taxonomyTerm.tmuid}): ${salesCount}`,
      );
    } else {
      salesCount = await this.sessionCounter.getSalesCount(
        'taxonomy',
        taxonomyTermUid,
      );
      this.logger.debug(
        `Sales count for taxonomy term ${taxonomyTerm.tmuid}: ${salesCount}`,
      );
    }

    const salesCountSource: 'redis' | 'database' | 'none' =
      salesCount > 0 ? 'redis' : 'none';

    if (salesCountSource === 'none') {
      this.logger.warn(
        `Sales count unavailable for term=${taxonomyTermUid} (no Redis entry and no session fallback). Returning 0.`,
      );
    }

    this.logger.log(
      `Prepared taxonomy snapshot for term=${taxonomyTermUid}: sales_count=${salesCount} (source=${salesCountSource}), session_profiles=${sessionProfiles.length}, sessions=${sessions.length}`,
    );

    return {
      taxonomy_term: {
        title: taxonomyTerm.name,
        description: taxonomyTerm.description ?? '',
        tmuid: taxonomyTerm.tmuid,
      },
      sales_count: salesCount,
      session_profiles: sessionProfiles.map((sp) => ({
        title: sp.title ?? '',
        description: sp.description ?? '',
        spuid: sp.spuid,
        is_active: sp.is_active,
        max_slots: sp.max_slots,
        sales_trigger_count: sp.sales_trigger_count,
        max_sessions: sp.max_sessions,
      })),
      sessions: sessions.map((s) => ({
        suid: s.suid,
        title: s.name ?? '',
        description: '',
        status: s.status,
        current_sales_count: s.current_sales_count,
        current_participant_count: s.current_participant_count,
      })),
    };
  }
}

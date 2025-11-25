import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedSocket } from '../../auth/types/socket.types';
import {
  TaxonomySalesService,
  type TaxonomySalesSnapshot,
} from '../services/taxonomy-sales.service';
import { calculateSalesPercentages } from '../utils/sales-percentage.util';
import { SessionStatus } from '../../../common/types/enums';

type PublicSessionProfileSnapshot = Omit<
  TaxonomySalesSnapshot['session_profiles'][number],
  'max_slots' | 'sales_trigger_count' | 'max_sessions'
>;

type PublicTaxonomySalesSnapshot = Omit<
  TaxonomySalesSnapshot,
  'session_profiles'
> & {
  session_profiles: PublicSessionProfileSnapshot[];
};

export interface TaxonomySalesJoinedPayload
  extends PublicTaxonomySalesSnapshot {
  // Compact format fields matching broadcastSalesCountUpdate response
  ss?: string; // Session status
  psr?: number | null; // Percentage sale reached
  psl?: number | null; // Percentage sale left
  sales_count: number; // Sales count (already in snapshot, but explicit here)
  ca: string; // Created at (same as updated_at)
}

@Injectable()
export class SocketTaxonomyController {
  private readonly logger = new Logger(SocketTaxonomyController.name);

  constructor(private readonly taxonomySalesService: TaxonomySalesService) {}

  async buildJoinResponse(
    authClient: AuthenticatedSocket,
    taxonomyTermId: string,
  ): Promise<TaxonomySalesJoinedPayload> {
    this.logger.log(
      `Client ${authClient.user?.userId} requested taxonomy sales join for term=${taxonomyTermId}`,
    );

    const snapshot =
      await this.taxonomySalesService.buildSalesSnapshot(taxonomyTermId);

    // Get session status from first session if available
    const sessionStatus = snapshot.sessions[0]?.status ?? null;

    // Calculate max sales from first session profile
    // Formula: max_sessions * sales_trigger_count (same as used in broadcastSalesCountUpdate)
    const firstSessionProfile = snapshot.session_profiles[0];
    let maxSales: number | null = null;

    maxSales = firstSessionProfile?.sales_trigger_count ?? null;

    // Calculate percentages using utility function (only for upcoming sessions)
    const { percentageSaleReached, percentageSaleLeft } =
      calculateSalesPercentages(snapshot.sales_count, maxSales);

    const shouldIncludePercentages = sessionStatus === SessionStatus.UPCOMING;

    const updatedAt = new Date().toISOString();

    const sanitizedSnapshot: PublicTaxonomySalesSnapshot = {
      ...snapshot,
      session_profiles: snapshot.session_profiles.map(
        ({ ...publicProfile }) => publicProfile,
      ),
    };

    const payload: TaxonomySalesJoinedPayload = {
      ...sanitizedSnapshot,
      // Compact format fields matching broadcastSalesCountUpdate response
      ss: sessionStatus || undefined,
      psr: shouldIncludePercentages ? percentageSaleReached : null,
      psl: shouldIncludePercentages ? percentageSaleLeft : null,
      sales_count: snapshot.sales_count, // Explicit for consistency
      ca: updatedAt, // Created at (same as updated_at)
    };

    this.logger.debug(
      `Taxonomy sales joined payload: ${JSON.stringify(payload, null, 2)}`,
    );

    return payload;
  }
}

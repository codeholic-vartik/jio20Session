import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedSocket } from '../../auth/types/socket.types';
import {
  TaxonomySalesService,
  type TaxonomySalesSnapshot,
} from '../services/taxonomy-sales.service';

export interface TaxonomySalesJoinedPayload extends TaxonomySalesSnapshot {
  updated_at: string;
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

    const payload: TaxonomySalesJoinedPayload = {
      ...snapshot,
      updated_at: new Date().toISOString(),
    };

    this.logger.debug(
      `Taxonomy sales joined payload: ${JSON.stringify(payload, null, 2)}`,
    );

    return payload;
  }
}

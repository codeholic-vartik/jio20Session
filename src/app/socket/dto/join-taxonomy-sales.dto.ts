import { IsString, IsNotEmpty } from 'class-validator';

/**
 * DTO for joining a taxonomy term's sales updates channel
 */
export class JoinTaxonomySalesDto {
  @IsString()
  @IsNotEmpty()
  taxonomy_term_id!: string; // e.g., "ttm_vt6ERZQiazfkM3P5822226"
}

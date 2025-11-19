import { IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

/**
 * Incoming payload for session sales socket events.
 * All fields are optional but at least one identifier must be present.
 */
export class SessionSalesPayloadDto {
  @IsOptional()
  @IsString()
  session_id?: string;

  @IsOptional()
  @IsString()
  session_profile_id?: string;

  @IsOptional()
  @IsString()
  taxonomy_term_id?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  count?: number;

  /**
   * Static method to deserialize the payload if it's a string
   */
  static deserialize(value: unknown): SessionSalesPayloadDto {
    // If the payload is a string, parse it first
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as SessionSalesPayloadDto;
        return parsed;
      } catch {
        // If parsing fails, return the value as-is (will be validated later)
        return value as SessionSalesPayloadDto;
      }
    }
    return value as SessionSalesPayloadDto;
  }
}

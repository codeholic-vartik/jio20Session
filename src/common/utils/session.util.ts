/**
 * Generates a session name with format: {title} SESSION - {number} or just {title}
 * If sessionNumber is provided, uses suffix format. Otherwise only trims title to maxLength.
 * Ensures the total length does not exceed the database varchar limit (200 chars).
 * Reserves 50 characters for suffix when sessionNumber is provided.
 *
 * @param title - The base title from session profile
 * @param sessionNumber - Optional session number (e.g., 1, 2, 3). If not provided, only title is used.
 * @param maxLength - Maximum allowed length (default: 200)
 * @returns Formatted session name: "{title} SESSION - {number}" or "{title}"
 *
 * @example
 * generateSessionName("My Product", 1) // "My Product SESSION - 1"
 * generateSessionName("Very Long Title That Exceeds Limit...", 5) // "...Title SESSION - 5" (trimmed)
 * generateSessionName("Very Long Title", null) // "Very Long Title" (trimmed to 200 chars)
 */
export function generateSessionName(
  title: string | null,
  sessionNumber: number | null | undefined,
  maxLength: number = 200,
): string {
  let trimmedTitle = title || '';

  // If session number is provided, use suffix format
  if (sessionNumber !== null && sessionNumber !== undefined) {
    const reservedSuffixLength = 50;
    let suffix = `Session - ${sessionNumber}`;

    // If suffix exceeds 50 chars, trim suffix. Otherwise keep full suffix (never trim if <= 50)
    if (suffix.length > reservedSuffixLength) {
      suffix = suffix.slice(-reservedSuffixLength);
    }

    // Reserve 50 chars for suffix space, calculate available space for title
    const maxTitleLength = maxLength - reservedSuffixLength - 1;

    // Trim title from front if needed
    if (trimmedTitle.length > maxTitleLength) {
      trimmedTitle = trimmedTitle.slice(-maxTitleLength);
    }

    return `${trimmedTitle} ${suffix}`.trim();
  }

  // If no session number, only trim title to maxLength
  if (trimmedTitle.length > maxLength) {
    trimmedTitle = trimmedTitle.slice(-maxLength);
  }

  return trimmedTitle;
}

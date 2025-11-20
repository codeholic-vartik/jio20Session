/**
 * Utility functions for calculating sales percentages
 */

export interface SalesPercentageResult {
  percentageSaleReached: number | null;
  percentageSaleLeft: number | null;
}

/**
 * Calculates percentage of sales reached and remaining
 *
 * @param currentCount - Current sales count
 * @param maxSales - Maximum sales (sales_trigger_count)
 * @returns Object with percentageSaleReached and percentageSaleLeft (0-100, or null if invalid)
 

 * ```
 */
export function calculateSalesPercentages(
  currentCount: number,
  maxSales: number | null | undefined,
): SalesPercentageResult {
  if (!maxSales || maxSales <= 0) {
    return {
      percentageSaleReached: null,
      percentageSaleLeft: null,
    };
  }

  const percentageSaleReached = Math.round((currentCount / maxSales) * 100);
  const percentageSaleLeft = Math.round(
    ((maxSales - currentCount) / maxSales) * 100,
  );

  return {
    percentageSaleReached,
    percentageSaleLeft,
  };
}

/**
 * @fileoverview Configuration utilities for Stripe integration
 * @description Provides environment-driven configuration for Stripe API credentials.
 */

import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('StripeConfig');

/**
 * Gets the Stripe secret key from environment variables.
 *
 * @environment STRIPE_SECRET_KEY - Stripe secret key
 * @returns {string | undefined} Stripe secret key or undefined if not set
 */
export function getStripeSecretKey(): string | undefined {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey || secretKey.trim().length === 0) {
    logger.warn('STRIPE_SECRET_KEY is not set in environment variables');
    return undefined;
  }

  return secretKey.trim();
}

/**
 * Gets Stripe configuration as an object.
 *
 * @returns {{ secretKey: string | undefined }} Object containing secret key
 */
export function getStripeConfig(): {
  secretKey: string | undefined;
} {
  return {
    secretKey: getStripeSecretKey(),
  };
}

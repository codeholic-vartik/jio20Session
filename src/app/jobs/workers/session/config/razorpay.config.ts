/**
 * @fileoverview Configuration utilities for Razorpay integration
 * @description Provides environment-driven configuration for Razorpay API credentials.
 */

import {
  createStandaloneLogger,
  StandaloneLogger,
} from '../../../../../common/logger/logger.util';

const logger: StandaloneLogger = createStandaloneLogger('RazorpayConfig');

/**
 * Gets the Razorpay client ID from environment variables.
 *
 * @environment RAZORPAY_CLIENT - Razorpay client ID/key
 * @returns {string | undefined} Razorpay client ID or undefined if not set
 */
export function getRazorpayClient(): string | undefined {
  const clientId = process.env.RAZORPAY_CLIENT;

  if (!clientId || clientId.trim().length === 0) {
    logger.warn('RAZORPAY_CLIENT is not set in environment variables');
    return undefined;
  }

  return clientId.trim();
}

/**
 * Gets the Razorpay secret key from environment variables.
 *
 * @environment RAZORPAY_SECRET - Razorpay secret key
 * @returns {string | undefined} Razorpay secret key or undefined if not set
 */
export function getRazorpaySecret(): string | undefined {
  const secret = process.env.RAZORPAY_SECRET;

  if (!secret || secret.trim().length === 0) {
    logger.warn('RAZORPAY_SECRET is not set in environment variables');
    return undefined;
  }

  return secret.trim();
}

/**
 * Gets both Razorpay credentials as an object.
 *
 * @returns {{ client: string | undefined; secret: string | undefined }} Object containing client ID and secret
 */
export function getRazorpayConfig(): {
  client: string | undefined;
  secret: string | undefined;
} {
  return {
    client: getRazorpayClient(),
    secret: getRazorpaySecret(),
  };
}

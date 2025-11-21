/**
 * Coupon Generator - Unique coupon code generation with encryption
 *
 * Generates 100% unique codes using timestamp with milliseconds and encrypts them
 *
 * Format: SES-[BASE62_SESSION]-[BASE62_USER]-[BASE62_TIMESTAMP]-[RANDOM]
 * Example: SES-1-1z-83uqO4fId-E5P5HA
 *
 * @author Vartik Anand
 * @year 2025
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import type { ConfigService } from '@nestjs/config';

/**
 * Base62 alphabet for encoding
 */
const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Configuration constants for coupon generation
 * These can be overridden via environment variables
 */
export class CouponConfig {
  static CODE_PREFIX = 'SES';
  static RANDOM_SUFFIX_LENGTH = 6;
  static SCUID_PREFIX = 'sc';
  static SCUID_NANO_LENGTH = 8;

  /**
   * Initialize config from environment variables
   */
  static initialize(configService?: {
    get: (key: string, defaultValue?: string) => string | undefined;
  }): void {
    if (configService) {
      this.CODE_PREFIX =
        configService.get('COUPON_CODE_PREFIX') || this.CODE_PREFIX;
      this.RANDOM_SUFFIX_LENGTH = Number.parseInt(
        configService.get('COUPON_RANDOM_SUFFIX_LENGTH') ||
          String(this.RANDOM_SUFFIX_LENGTH),
        10,
      );
      this.SCUID_PREFIX =
        configService.get('COUPON_SCUID_PREFIX') || this.SCUID_PREFIX;
      this.SCUID_NANO_LENGTH = Number.parseInt(
        configService.get('COUPON_SCUID_NANO_LENGTH') ||
          String(this.SCUID_NANO_LENGTH),
        10,
      );
    }
  }
}

/**
 * Base62 encoding utility
 */
export class Base62 {
  /**
   * Encode a number to base62 (0-9, A-Z, a-z) for compact representation
   */
  static encode(number: number): string {
    if (number === 0) {
      return BASE62_ALPHABET[0];
    }

    const result: string[] = [];
    let num = number;

    while (num > 0) {
      const remainder = num % 62;
      result.push(BASE62_ALPHABET[remainder]);
      num = Math.floor(num / 62);
    }

    return result.reverse().join('');
  }

  /**
   * Decode a base62 string back to an integer
   */
  static decode(encoded: string): number {
    let number = 0;

    for (let i = 0; i < encoded.length; i++) {
      const char = encoded[i];
      const index = BASE62_ALPHABET.indexOf(char);

      if (index === -1) {
        throw new Error(`Invalid base62 character: ${char}`);
      }

      number = number * 62 + index;
    }

    return number;
  }
}

/**
 * Encryption utility using Fernet format (compatible with Python cryptography.fernet)
 *
 * Fernet format:
 * - Version (1 byte) = 0x80
 * - Timestamp (8 bytes) = current time in seconds
 * - IV (16 bytes) = random initialization vector
 * - Ciphertext (variable) = AES-128-CBC encrypted data
 * - HMAC (32 bytes) = HMAC-SHA256 signature
 *
 * All encoded as base64url (URL-safe base64)
 */
export class CouponEncryption {
  private static readonly FERNET_VERSION = 0x80;
  private static readonly ALGORITHM = 'aes-128-cbc';
  private static readonly IV_LENGTH = 16;
  private static readonly HMAC_LENGTH = 32;
  private static readonly TIMESTAMP_LENGTH = 8;
  private static readonly VERSION_LENGTH = 1;

  /**
   * Get encryption key from environment variable
   * Matches Python implementation:
   * 1. Get hex string from env
   * 2. Convert hex to bytes (32 bytes)
   * 3. Use those bytes directly (Fernet internally derives signing/encryption keys)
   *
   * Python code: bytes.fromhex(hex_string) -> 32 bytes -> Fernet uses as-is
   */
  static getEncryptionKey(configService: ConfigService): Buffer {
    const encryptionKeyHex = configService.get<string>(
      'SESSION_ENCRYPTION_KEY',
    );

    if (!encryptionKeyHex) {
      throw new Error(
        'SESSION_ENCRYPTION_KEY is not configured. Please set it in your .env file.',
      );
    }

    // Validate hex string length (64 hex chars = 32 bytes for SHA-256)
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new Error(
        'SESSION_ENCRYPTION_KEY must be a 64-character hex string (SHA-256 hash).',
      );
    }

    // Convert hex to bytes (32 bytes) - matches Python: bytes.fromhex(hex_string)
    const keyBytes = Buffer.from(encryptionKeyHex, 'hex');

    if (keyBytes.length !== 32) {
      throw new Error(
        'SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters).',
      );
    }

    // Return the 32-byte key
    // Fernet internally splits: first 16 bytes = signing key, last 16 bytes = encryption key
    return keyBytes;
  }

  /**
   * Base64url encode (URL-safe base64)
   */
  private static base64urlEncode(buffer: Buffer): string {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Base64url decode (URL-safe base64)
   */
  private static base64urlDecode(str: string): Buffer {
    // Add padding if needed
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    return Buffer.from(base64, 'base64');
  }

  /**
   * Encrypt a coupon code for database storage (Fernet format)
   */
  static encrypt(plainCode: string, key: Buffer): string {
    // Derive signing key (first 16 bytes) and encryption key (last 16 bytes)
    const signingKey = key.subarray(0, 16);
    const encryptionKey = key.subarray(16, 32);

    // Generate IV
    const iv = randomBytes(this.IV_LENGTH);

    // Get current timestamp (8 bytes, big-endian)
    const timestamp = Buffer.allocUnsafe(this.TIMESTAMP_LENGTH);
    const now = Math.floor(Date.now() / 1000);
    timestamp.writeBigUInt64BE(BigInt(now), 0);

    // Encrypt the plaintext using AES-128-CBC
    const cipher = createCipheriv(this.ALGORITHM, encryptionKey, iv);
    let encrypted = cipher.update(plainCode, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    // Build the token: Version + Timestamp + IV + Ciphertext
    const token = Buffer.concat([
      Buffer.from([this.FERNET_VERSION]),
      timestamp,
      iv,
      encrypted,
    ]);

    // Calculate HMAC-SHA256 signature
    const hmac = createHmac('sha256', signingKey);
    hmac.update(token);
    const signature = hmac.digest();

    // Combine token + signature
    const finalToken = Buffer.concat([token, signature]);

    // Return as base64url encoded string
    return this.base64urlEncode(finalToken);
  }

  /**
   * Decrypt a coupon code for display to users (Fernet format)
   */
  static decrypt(encryptedCode: string, key: Buffer): string {
    // Decode from base64url
    const token = this.base64urlDecode(encryptedCode);

    // Derive signing key (first 16 bytes) and encryption key (last 16 bytes)
    const signingKey = key.subarray(0, 16);
    const encryptionKey = key.subarray(16, 32);

    // Extract components
    const version = token[0];
    if (version !== this.FERNET_VERSION) {
      throw new Error(`Invalid Fernet version: ${version}`);
    }

    const iv = token.subarray(
      this.VERSION_LENGTH + this.TIMESTAMP_LENGTH,
      this.VERSION_LENGTH + this.TIMESTAMP_LENGTH + this.IV_LENGTH,
    );
    const hmacReceived = token.subarray(token.length - this.HMAC_LENGTH);
    const ciphertext = token.subarray(
      this.VERSION_LENGTH + this.TIMESTAMP_LENGTH + this.IV_LENGTH,
      token.length - this.HMAC_LENGTH,
    );

    // Verify HMAC
    const tokenWithoutHmac = token.subarray(0, token.length - this.HMAC_LENGTH);
    const hmac = createHmac('sha256', signingKey);
    hmac.update(tokenWithoutHmac);
    const hmacCalculated = hmac.digest();

    if (!hmacCalculated.equals(hmacReceived)) {
      throw new Error('Invalid HMAC - token may have been tampered with');
    }

    // Optional: Check timestamp (not expired)
    // You can add TTL validation here if needed

    // Decrypt the ciphertext
    const decipher = createDecipheriv(this.ALGORITHM, encryptionKey, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  }
}

/**
 * Coupon Code Generator
 * Generates unique, encrypted session coupon codes
 */
export class CouponCodeGenerator {
  /**
   * Generate unique coupon code (plain text, no encryption)
   */
  static generateUniqueCode(
    sessionId: number,
    userId: number,
    randomLength: number = CouponConfig.RANDOM_SUFFIX_LENGTH,
  ): string {
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const milliseconds = now.getMilliseconds();
    const uniqueTimestamp = timestampSeconds * 1000000 + milliseconds * 1000;

    const sessionEncoded = Base62.encode(sessionId);
    const userEncoded = Base62.encode(userId);
    const timestampEncoded = Base62.encode(uniqueTimestamp);

    // Generate random suffix (uppercase letters and digits)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomSuffix = Array.from(
      { length: randomLength },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('');

    // Build code without separators
    const prefix = CouponConfig.CODE_PREFIX;
    const code = `${prefix}${sessionEncoded}${userEncoded}${timestampEncoded}${randomSuffix}`;

    return code;
  }

  /**
   * Generate unique code and return both plain and encrypted versions
   */
  static generateAndEncrypt(
    sessionId: number,
    userId: number,
    encryptionKey: Buffer,
    randomLength: number = CouponConfig.RANDOM_SUFFIX_LENGTH,
  ): { plainCode: string; encryptedCode: string } {
    const plainCode = this.generateUniqueCode(sessionId, userId, randomLength);
    const encryptedCode = CouponEncryption.encrypt(plainCode, encryptionKey);

    return { plainCode, encryptedCode };
  }

  /**
   * Encrypt a coupon code
   */
  static encryptCode(plainCode: string, encryptionKey: Buffer): string {
    return CouponEncryption.encrypt(plainCode, encryptionKey);
  }

  /**
   * Decrypt a coupon code
   */
  static decryptCode(encryptedCode: string, encryptionKey: Buffer): string {
    return CouponEncryption.decrypt(encryptedCode, encryptionKey);
  }

  /**
   * Parse coupon code to extract basic validation info
   */
  static parseCouponCode(code: string): {
    is_valid_format: boolean;
    prefix?: string;
    middle_encoded?: string;
    random_suffix?: string;
    error?: string;
  } {
    try {
      const prefix = code.substring(0, 3);
      if (prefix !== CouponConfig.CODE_PREFIX) {
        return { is_valid_format: false, error: 'Invalid prefix' };
      }

      const randomSuffix = code.substring(
        code.length - CouponConfig.RANDOM_SUFFIX_LENGTH,
      );
      const middle = code.substring(
        3,
        code.length - CouponConfig.RANDOM_SUFFIX_LENGTH,
      );

      return {
        prefix,
        middle_encoded: middle,
        random_suffix: randomSuffix,
        is_valid_format: true,
      };
    } catch (error) {
      return {
        is_valid_format: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate if a coupon code has the correct format
   */
  static validateCouponCodeFormat(code: string): {
    isValid: boolean;
    errorMessage: string;
  } {
    if (!code || typeof code !== 'string') {
      return {
        isValid: false,
        errorMessage: 'Code must be a non-empty string',
      };
    }

    const parsed = this.parseCouponCode(code);

    if (!parsed.is_valid_format) {
      return {
        isValid: false,
        errorMessage: parsed.error || 'Invalid code format',
      };
    }

    // Check if prefix matches expected
    if (parsed.prefix !== CouponConfig.CODE_PREFIX) {
      return {
        isValid: false,
        errorMessage: `Invalid prefix. Expected ${CouponConfig.CODE_PREFIX}`,
      };
    }

    return { isValid: true, errorMessage: '' };
  }

  /**
   * Generate unique public identifier for SessionCoupon (SCUID)
   */
  static generateScuid(prefix?: string): string {
    const scuidPrefix = prefix || CouponConfig.SCUID_PREFIX;
    const timestamp = Math.floor(Date.now() / 1000)
      .toString()
      .slice(-6);

    const alphabet =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const nanoId = Array.from(
      { length: CouponConfig.SCUID_NANO_LENGTH },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('');

    return `${scuidPrefix.toLowerCase()}_${nanoId}${timestamp}`;
  }
}

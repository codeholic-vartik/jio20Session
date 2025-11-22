import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CouponCodeGenerator,
  CouponEncryption,
  CouponConfig,
} from './coupon-generator.util';

/**
 * Service wrapper for coupon generation utilities
 * Provides dependency injection for ConfigService
 */
@Injectable()
export class CouponGeneratorService implements OnModuleInit {
  private encryptionKey: Buffer | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Initialize config from environment variables
    CouponConfig.initialize(this.configService);
  }

  /**
   * Get or initialize encryption key
   */
  private getEncryptionKey(): Buffer {
    if (!this.encryptionKey) {
      this.encryptionKey = CouponEncryption.getEncryptionKey(
        this.configService,
      );
    }
    return this.encryptionKey;
  }

  /**
   * Generate unique coupon code (plain text)
   */
  generateUniqueCode(
    sessionId: number,
    userId: number,
    randomLength?: number,
  ): string {
    return CouponCodeGenerator.generateUniqueCode(
      sessionId,
      userId,
      randomLength,
    );
  }

  /**
   * Generate unique code and return both plain and encrypted versions
   */
  generateAndEncrypt(
    sessionId: number,
    userId: number,
    randomLength?: number,
  ): { plainCode: string; encryptedCode: string } {
    const encryptionKey = this.getEncryptionKey();
    return CouponCodeGenerator.generateAndEncrypt(
      sessionId,
      userId,
      encryptionKey,
      randomLength,
    );
  }

  /**
   * Encrypt a coupon code
   */
  encryptCode(plainCode: string): string {
    const encryptionKey = this.getEncryptionKey();
    return CouponCodeGenerator.encryptCode(plainCode, encryptionKey);
  }

  /**
   * Decrypt a coupon code
   */
  decryptCode(encryptedCode: string): string {
    const encryptionKey = this.getEncryptionKey();
    return CouponCodeGenerator.decryptCode(encryptedCode, encryptionKey);
  }

  /**
   * Parse coupon code
   */
  parseCouponCode(code: string) {
    return CouponCodeGenerator.parseCouponCode(code);
  }

  /**
   * Validate coupon code format
   */
  validateCouponCodeFormat(code: string) {
    return CouponCodeGenerator.validateCouponCodeFormat(code);
  }

  /**
   * Generate SCUID
   */
  generateScuid(prefix?: string): string {
    return CouponCodeGenerator.generateScuid(prefix);
  }
}

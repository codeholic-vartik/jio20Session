#!/usr/bin/env ts-node

/**
 * Simple script to encrypt and decrypt coupon codes
 *
 * Usage:
 *   npm run encrypt-decrypt-coupon
 *   or
 *   ts-node scripts/encrypt-decrypt-coupon.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CouponEncryption } from '../src/app/coupon/utils/coupon-generator.util';

// Load environment variables from .env file
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '../.env');
    const envFile = readFileSync(envPath, 'utf-8');
    const lines = envFile.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim();
          const cleanValue = value.replace(/^["']|["']$/g, '');
          process.env[key.trim()] = cleanValue;
        }
      }
    }
  } catch {
    console.warn('⚠️  .env file not found, using environment variables');
  }
}

loadEnv();

function main() {
  console.log('🔐 Coupon Encryption/Decryption Tool\n');
  console.log('='.repeat(60));

  // Check encryption key
  const encryptionKeyHex = process.env.SESSION_ENCRYPTION_KEY;
  if (!encryptionKeyHex) {
    console.error('❌ ERROR: SESSION_ENCRYPTION_KEY not found in .env file');
    console.log('\nPlease add to your .env file:');
    console.log('SESSION_ENCRYPTION_KEY=your-64-character-hex-string');
    console.log('\nGenerate one with: openssl rand -hex 32');
    process.exit(1);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    console.error('❌ ERROR: SESSION_ENCRYPTION_KEY must be 64 hex characters');
    process.exit(1);
  }

  // Get encryption key directly from environment
  const keyBytes = Buffer.from(encryptionKeyHex, 'hex');
  const encryptionKey = keyBytes;

  // Get coupon code from command line arguments
  const args = process.argv.slice(2);
  let couponCode: string | null = null;
  let encryptedCodeInput: string | null = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--encrypt' || args[i] === '-e') {
      couponCode = args[i + 1];
      i++;
    } else if (args[i] === '--decrypt' || args[i] === '-d') {
      encryptedCodeInput = args[i + 1];
      i++;
    } else if (!couponCode && !encryptedCodeInput) {
      // If no flag, assume it's a plain code to encrypt
      couponCode = args[i];
    }
  }

  // If no arguments, show usage
  if (!couponCode && !encryptedCodeInput) {
    console.log('Usage:');
    console.log('  Encrypt a code:');
    console.log(
      '    npm run encrypt-decrypt-coupon --encrypt "SES-1-123-abc-XYZ123"',
    );
    console.log('    npm run encrypt-decrypt-coupon -e "SES-1-123-abc-XYZ123"');
    console.log('');
    console.log('  Decrypt a code:');
    console.log(
      '    npm run encrypt-decrypt-coupon --decrypt "encrypted_string_here"',
    );
    console.log(
      '    npm run encrypt-decrypt-coupon -d "encrypted_string_here"',
    );
    console.log('');
    console.log('  Encrypt and decrypt (full cycle):');
    console.log('    npm run encrypt-decrypt-coupon "SES-1-123-abc-XYZ123"');
    console.log('');
    process.exit(0);
  }

  // Encrypt mode
  if (couponCode) {
    console.log(`📝 Original Code: ${couponCode}\n`);

    console.log('🔒 Encrypting...');
    const encryptedCode = CouponEncryption.encrypt(couponCode, encryptionKey);
    console.log(`✅ Encrypted Code: ${encryptedCode}\n`);

    // If only encrypting, show result and exit
    if (!encryptedCodeInput) {
      console.log('='.repeat(60));
      console.log('\n✅ Encryption complete!');
      console.log(`\nOriginal:  ${couponCode}`);
      console.log(`Encrypted: ${encryptedCode}\n`);
      return;
    }

    // If also decrypting, use the newly encrypted code
    encryptedCodeInput = encryptedCode;
  }

  // Decrypt mode
  if (encryptedCodeInput) {
    console.log(`🔐 Encrypted Code: ${encryptedCodeInput}\n`);

    console.log('🔓 Decrypting...');
    try {
      const decryptedCode = CouponEncryption.decrypt(
        encryptedCodeInput,
        encryptionKey,
      );
      console.log(`✅ Decrypted Code: ${decryptedCode}\n`);

      // Verify if we also encrypted
      if (couponCode) {
        if (decryptedCode === couponCode) {
          console.log('✅ SUCCESS: Decryption matches original!\n');
          console.log('='.repeat(60));
          console.log('\nSummary:');
          console.log(`  Original:  ${couponCode}`);
          console.log(`  Encrypted: ${encryptedCodeInput}`);
          console.log(`  Decrypted: ${decryptedCode}`);
          console.log('\n✅ Encryption/Decryption working correctly!\n');
        } else {
          console.error('❌ ERROR: Decrypted code does not match!');
          console.log(`Expected: ${couponCode}`);
          console.log(`Got: ${decryptedCode}`);
          process.exit(1);
        }
      } else {
        // Just decrypting
        console.log('='.repeat(60));
        console.log('\n✅ Decryption complete!');
        console.log(`\nEncrypted: ${encryptedCodeInput}`);
        console.log(`Decrypted: ${decryptedCode}\n`);
      }
    } catch (error) {
      console.error('❌ ERROR: Decryption failed');
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

// Run
try {
  main();
} catch (error) {
  console.error(
    '❌ Fatal error:',
    error instanceof Error ? error.message : String(error),
  );
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}

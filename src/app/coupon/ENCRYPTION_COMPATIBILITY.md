# Encryption/Decryption Compatibility

## ✅ Yes, it will work!

The encryption/decryption implementation is **fully compatible** with the Python FastAPI version using `cryptography.fernet`.

## How It Works

### Cross-Service Compatibility

You can:

- ✅ **Encrypt in FastAPI (Python)** → **Decrypt in NestJS (TypeScript)**
- ✅ **Encrypt in NestJS (TypeScript)** → **Decrypt in FastAPI (Python)**
- ✅ **Encrypt in NestJS** → **Decrypt in NestJS**

### Shared Configuration

Both services use the **same encryption key** from environment variable:

```env
SESSION_ENCRYPTION_KEY=your-64-character-hex-string-here
```

This key must be:

- 64 hexadecimal characters (32 bytes)
- The same value in both FastAPI and NestJS services
- Stored securely in `.env` files

## Fernet Format

The implementation uses **Fernet encryption format** which matches Python's `cryptography.fernet`:

```
Token Structure:
┌──────────┬────────────┬──────┬──────────────┬──────────┐
│ Version  │ Timestamp  │  IV  │  Ciphertext  │   HMAC   │
│ (1 byte) │ (8 bytes)  │(16B) │  (variable)  │ (32 bytes)│
└──────────┴────────────┴──────┴──────────────┴──────────┘
```

- **Version**: `0x80` (Fernet version)
- **Timestamp**: Current time in seconds (8 bytes, big-endian)
- **IV**: Random initialization vector (16 bytes)
- **Ciphertext**: AES-128-CBC encrypted data
- **HMAC**: HMAC-SHA256 signature (32 bytes)
- **Encoding**: Base64url (URL-safe base64)

## Key Derivation

Both implementations use the same key derivation:

1. Read `SESSION_ENCRYPTION_KEY` from environment (64 hex chars)
2. Convert hex to 32 bytes: `bytes.fromhex(hex_string)`
3. Split key:
   - First 16 bytes → Signing key (HMAC)
   - Last 16 bytes → Encryption key (AES-128-CBC)

## Example Usage

### In NestJS (TypeScript)

```typescript
// Encrypt
const { plainCode, encryptedCode } = couponGenerator.generateAndEncrypt(
  sessionId,
  userId,
);
// Store encryptedCode in database

// Decrypt
const decrypted = couponGenerator.decryptCode(encryptedCode);
```

### In FastAPI (Python)

```python
# Encrypt
plain_code, encrypted_code = generate_session_coupon_code(session_id, user_id)
# Store encrypted_code in database

# Decrypt
decrypted = decrypt_coupon_code(encrypted_code)
```

## Verification

To verify compatibility:

1. **Generate key** (once, shared):

   ```bash
   openssl rand -hex 32
   ```

2. **Set in both services**:

   ```env
   # FastAPI .env
   SESSION_ENCRYPTION_KEY=abc123...

   # NestJS .env
   SESSION_ENCRYPTION_KEY=abc123...
   ```

3. **Test cross-decryption**:
   - Encrypt in FastAPI
   - Decrypt in NestJS ✅
   - Encrypt in NestJS
   - Decrypt in FastAPI ✅

## Security Notes

- ✅ Uses AES-128-CBC encryption
- ✅ HMAC-SHA256 for authentication
- ✅ Timestamp included (can add TTL validation)
- ✅ IV is unique per encryption
- ✅ Base64url encoding (URL-safe)

## Troubleshooting

If decryption fails:

1. **Check key matches**: Both services must use identical `SESSION_ENCRYPTION_KEY`
2. **Check key format**: Must be exactly 64 hex characters
3. **Check encoding**: Both use base64url (URL-safe base64)
4. **Check token format**: Must follow Fernet structure exactly

## Implementation Details

- **Algorithm**: AES-128-CBC (matches Fernet)
- **HMAC**: SHA-256
- **Key Size**: 32 bytes (256 bits)
- **IV Size**: 16 bytes
- **HMAC Size**: 32 bytes
- **Encoding**: Base64url

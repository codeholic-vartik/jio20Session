# Coupon Module

Coupon generation and encryption utilities for session coupons.

## Structure

```
coupon/
├── coupon.controller.ts          # REST API controller
├── coupon.service.ts             # Business logic service
├── coupon.module.ts              # NestJS module
└── utils/
    ├── coupon-generator.util.ts  # Core utilities (Base62, encryption, generation)
    └── coupon-generator.service.ts # Injectable service wrapper
```

## Configuration

### Environment Variables

Add these to your `.env` file:

```env
# Required: SHA-256 hash (64 hex characters) for encrypting coupon codes
SESSION_ENCRYPTION_KEY=your-64-character-hex-string-here

# Optional: Coupon code configuration
COUPON_CODE_PREFIX=SES                    # Default: SES
COUPON_RANDOM_SUFFIX_LENGTH=6             # Default: 6 (1-20)
COUPON_SCUID_PREFIX=sc                    # Default: sc
COUPON_SCUID_NANO_LENGTH=8                # Default: 8 (1-20)
```

### Generating Encryption Key

The `SESSION_ENCRYPTION_KEY` must be a 64-character hexadecimal string (32 bytes). You can generate one using:

```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

## Usage

### In Services

```typescript
import { CouponGeneratorService } from './utils/coupon-generator.service';

@Injectable()
export class MyService {
  constructor(private readonly couponGenerator: CouponGeneratorService) {}

  generateCoupon(sessionId: number, userId: number) {
    // Generate both plain and encrypted versions
    const { plainCode, encryptedCode } =
      this.couponGenerator.generateAndEncrypt(sessionId, userId);

    // Store encryptedCode in database
    // Show plainCode to user

    return { plainCode, encryptedCode };
  }

  decryptCoupon(encryptedCode: string) {
    return this.couponGenerator.decryptCode(encryptedCode);
  }

  validateCoupon(code: string) {
    const { isValid, errorMessage } =
      this.couponGenerator.validateCouponCodeFormat(code);
    return isValid;
  }
}
```

### Direct Utility Functions

```typescript
import {
  CouponCodeGenerator,
  Base62,
  CouponEncryption,
} from './utils/coupon-generator.util';

// Generate unique code
const code = CouponCodeGenerator.generateUniqueCode(1, 123);

// Base62 encoding
const encoded = Base62.encode(12345); // "dnh"
const decoded = Base62.decode('dnh'); // 12345

// Generate SCUID
const scuid = CouponCodeGenerator.generateScuid(); // "sc_abc12345678901234"
```

## Code Format

Coupon codes follow this format:

```
SES-[BASE62_SESSION]-[BASE62_USER]-[BASE62_TIMESTAMP]-[RANDOM]
```

Example: `SES-1-1z-83uqO4fId-E5P5HA`

- **Prefix**: `SES` (configurable via `COUPON_CODE_PREFIX`)
- **Session ID**: Base62 encoded session ID
- **User ID**: Base62 encoded user ID
- **Timestamp**: Base62 encoded timestamp (microsecond precision)
- **Random**: Random alphanumeric suffix (length configurable)

## Encryption

- Uses **AES-256-GCM** encryption (similar to Fernet)
- Encryption key stored in `SESSION_ENCRYPTION_KEY` environment variable
- Encrypted codes are base64 encoded for database storage
- Supports encrypt/decrypt operations for secure storage

## Features

- ✅ Unique code generation with microsecond precision
- ✅ Base62 encoding for compact representation
- ✅ AES-256-GCM encryption for secure storage
- ✅ Code validation and parsing
- ✅ SCUID generation for public identifiers
- ✅ Configurable via environment variables

## Author

Vartik Anand - 2025

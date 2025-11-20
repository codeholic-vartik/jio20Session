# JWT Authentication Flow & Security

Complete documentation of JWT token validation, blacklist checking, and security measures for WebSocket connections.

## Table of Contents

1. [Overview](#overview)
2. [JWT Token Structure](#jwt-token-structure)
3. [Authentication Flow](#authentication-flow)
4. [Security Checks](#security-checks)
5. [Blacklist System](#blacklist-system)
6. [Database Models](#database-models)
7. [Error Handling](#error-handling)
8. [Best Practices](#best-practices)

---

## Overview

The JWT authentication system provides secure token-based authentication for WebSocket connections. It validates tokens, checks blacklists, and verifies user status before allowing connections.

### Key Components

- **JwtAuthService**: Core token validation service
- **Socket Gateway**: Handles WebSocket connections with JWT validation
- **Blacklist System**: Tracks revoked tokens in database
- **User Validation**: Verifies user account status

---

## JWT Token Structure

### Token Payload

```typescript
interface JwtPayload {
  sub: string | number; // User ID (subject)
  email?: string; // User email
  uuid?: string; // User UUID
  user_id?: string; // External user identifier
  type?: 'access' | 'refresh'; // Token type
  iat?: number; // Issued at (timestamp)
  exp?: number; // Expiration (timestamp)
  jti?: string; // JWT ID (for blacklisting)
}
```

### Required Fields

- **`sub`**: User identifier (required)
- **`exp`**: Expiration timestamp (required for expiration check)
- **`jti`**: JWT ID (recommended for blacklist support)

---

## Authentication Flow

### Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│              JWT AUTHENTICATION FLOW                         │
└─────────────────────────────────────────────────────────────┘

1. CLIENT CONNECTS
   │
   ├─→ WebSocket connection to /ws/v1/session/
   │
   └─→ Sends JWT token in:
       ├─→ auth.token (recommended)
       ├─→ Authorization header
       └─→ query.token (fallback)

2. TOKEN EXTRACTION
   │
   ├─→ Extract from auth object (Socket.IO v4+)
   ├─→ Extract from Authorization header
   └─→ Extract from query parameters (fallback)

3. TOKEN VALIDATION
   │
   ├─→ Remove 'Bearer ' prefix if present
   │
   ├─→ JWT VERIFICATION
   │   ├─→ Verify signature with JWT_SECRET_KEY
   │   ├─→ Check expiration (exp claim)
   │   └─→ Validate token structure
   │
   ├─→ BLACKLIST CHECK
   │   ├─→ Check by JTI (JWT ID) - Primary method
   │   ├─→ Check by token string - Fallback
   │   └─→ Verify blacklist entry hasn't expired
   │
   └─→ USER VALIDATION
       ├─→ Lookup user by ID or UUID
       ├─→ Check user exists
       ├─→ Check user is active (is_active = true)
       ├─→ Check user not deleted (is_deleted = false)
       └─→ Check user not blocked (is_blocked = false)

4. CONNECTION RESULT
   │
   ├─→ ✅ SUCCESS
   │   ├─→ Attach user info to socket
   │   ├─→ Join user-specific rooms
   │   └─→ Emit 'authenticated' event
   │
   └─→ ❌ FAILURE
       ├─→ Emit 'error' event with code
       └─→ Disconnect client
```

---

## Security Checks

### 1. Token Expiration Check

**Automatic**: Handled by `jwtService.verify()`

```typescript
// NestJS JwtService automatically checks:
// - exp claim exists
// - exp > current timestamp
// - Throws TokenExpiredError if expired

decoded = this.jwtService.verify(token, {
  secret: this.jwtSecret,
});
```

**Error**: `TokenExpiredError` → `"Token has expired"`

### 2. Token Signature Verification

**Automatic**: Handled by `jwtService.verify()`

```typescript
// Verifies token signature using JWT_SECRET_KEY
// Ensures token wasn't tampered with
```

**Error**: `JsonWebTokenError` → `"Invalid token"`

### 3. Blacklist Check

**Two-Step Process**:

```typescript
// Step 1: Check by JTI (JWT ID) - Most efficient
if (decoded.jti) {
  blacklisted = await prisma.frontend_token_blacklist.findUnique({
    where: { jti: decoded.jti },
  });
}

// Step 2: Fallback - Check by token string
if (!blacklisted) {
  blacklisted = await prisma.frontend_token_blacklist.findFirst({
    where: { token: cleanToken },
  });
}

// Step 3: Verify blacklist entry hasn't expired
if (blacklisted && blacklisted.expires_at > new Date()) {
  throw new UnauthorizedException('Token has been revoked');
}
```

**Error**: `"Token has been revoked"`

### 4. User Existence Check

```typescript
const user = await prisma.frontendusers.findUnique({
  where: { id: userId }, // or { uuid: userUuid }
});
```

**Error**: `"User not found"`

### 5. User Active Status Check

```typescript
if (user.is_active === false) {
  throw new UnauthorizedException('User account is inactive');
}
```

**Error**: `"User account is inactive"`

### 6. User Deleted Check

```typescript
if (user.is_deleted === true) {
  throw new UnauthorizedException('User account has been deleted');
}
```

**Error**: `"User account has been deleted"`

### 7. User Blocked Check

```typescript
if (user.is_blocked) {
  if (user.blocked_until && user.blocked_until > new Date()) {
    throw new UnauthorizedException('User account is temporarily blocked');
  }
}
```

**Error**: `"User account is temporarily blocked"`

---

## Blacklist System

### Database Model

**Table**: `frontend_token_blacklist` (schema: `frontend`)

```prisma
model frontend_token_blacklist {
  jti            String    @id @db.VarChar(64)      // JWT ID (primary key)
  token          String                              // Full token string
  blacklisted_at DateTime? @db.Timestamp(6)         // When blacklisted
  expires_at     DateTime  @db.Timestamp(6)         // Token expiration
  reason         String?   @db.VarChar              // Reason for blacklisting

  @@index([jti], map: "ix_frontend_frontend_token_blacklist_jti")
  @@schema("frontend")
}
```

### Blacklist Check Flow

1. **Primary Check (by JTI)**

   - Uses `jti` (JWT ID) from token payload
   - Fast lookup using indexed primary key
   - Most efficient method

2. **Fallback Check (by Token String)**

   - If `jti` is missing or not found
   - Searches by full token string
   - Ensures tokens without `jti` are still checked

3. **Expiration Check**
   - Verifies blacklist entry hasn't expired
   - Old blacklist entries are automatically ignored
   - Prevents false positives from expired entries

### Adding Tokens to Blacklist

```typescript
// Example: Add token to blacklist
await prisma.frontend_token_blacklist.create({
  data: {
    jti: decoded.jti || generateJti(),
    token: cleanToken,
    blacklisted_at: new Date(),
    expires_at: new Date(decoded.exp * 1000), // Convert exp to Date
    reason: 'User logged out',
  },
});
```

### When to Blacklist

- User logs out
- Password changed
- Account compromised
- Admin revokes access
- Token refresh (old access token)

---

## Database Models

### frontend_token_blacklist

Stores blacklisted JWT tokens.

| Field            | Type        | Description                |
| ---------------- | ----------- | -------------------------- |
| `jti`            | String (PK) | JWT ID - unique identifier |
| `token`          | String      | Full token string          |
| `blacklisted_at` | DateTime?   | When token was blacklisted |
| `expires_at`     | DateTime    | Token expiration time      |
| `reason`         | String?     | Reason for blacklisting    |

### frontendusers

User account information.

| Field           | Type            | Description            |
| --------------- | --------------- | ---------------------- |
| `id`            | Int (PK)        | User ID                |
| `uuid`          | String (Unique) | User UUID              |
| `is_active`     | Boolean         | Account active status  |
| `is_deleted`    | Boolean         | Account deleted status |
| `is_blocked`    | Boolean         | Account blocked status |
| `blocked_until` | DateTime?       | Block expiration time  |

---

## Error Handling

### Error Codes

| Code            | Message                               | Cause                    |
| --------------- | ------------------------------------- | ------------------------ |
| `AUTH_REQUIRED` | "Authentication required"             | No token provided        |
| `AUTH_FAILED`   | "Authentication failed"               | Token validation failed  |
| -               | "Token has expired"                   | Token `exp` claim passed |
| -               | "Invalid token"                       | Token signature invalid  |
| -               | "Token has been revoked"              | Token found in blacklist |
| -               | "User not found"                      | User doesn't exist       |
| -               | "User account is inactive"            | `is_active = false`      |
| -               | "User account has been deleted"       | `is_deleted = true`      |
| -               | "User account is temporarily blocked" | `is_blocked = true`      |

### Error Response Format

```typescript
socket.emit('error', {
  message: 'Token has been revoked',
  code: 'AUTH_FAILED',
});
```

---

## Best Practices

### 1. Token Storage

✅ **DO**:

- Store tokens securely (httpOnly cookies, secure localStorage)
- Include `jti` in all tokens for blacklist support
- Set appropriate expiration times

❌ **DON'T**:

- Store tokens in plain text
- Use query parameters for tokens (logged in server logs)
- Share tokens between users

### 2. Token Validation

✅ **DO**:

- Always validate token signature
- Check expiration before processing
- Verify blacklist status
- Validate user account status

❌ **DON'T**:

- Skip blacklist checks
- Trust client-side validation only
- Accept expired tokens

### 3. Blacklist Management

✅ **DO**:

- Blacklist tokens on logout
- Blacklist tokens on password change
- Clean up expired blacklist entries periodically
- Include reason for blacklisting

❌ **DON'T**:

- Keep blacklist entries indefinitely
- Skip blacklist checks for performance
- Use blacklist for rate limiting

### 4. Security

✅ **DO**:

- Use strong JWT secrets
- Rotate secrets periodically
- Monitor blacklist usage
- Log authentication failures

❌ **DON'T**:

- Expose JWT secrets
- Log full tokens (security risk)
- Skip user status checks

---

## Implementation Example

### Client Side

```typescript
import { io } from 'socket.io-client';

const token = localStorage.getItem('access_token');

const socket = io(WS_URL, {
  auth: { token }, // Recommended method
  transports: ['websocket', 'polling'],
});

socket.on('authenticated', (data) => {
  console.log('Authenticated:', data);
  // { userId: 123, userUuid: "uuid-456", message: "Successfully authenticated" }
});

socket.on('error', (error) => {
  if (error.code === 'AUTH_FAILED') {
    // Handle auth failure
    // - Token expired: Refresh token
    // - Token revoked: Redirect to login
    // - User blocked: Show message
  }
});
```

### Server Side

```typescript
// Automatic validation in SocketGateway
async handleConnection(client: AuthenticatedSocket) {
  const token = this.jwtAuthService.extractTokenFromSocket(client);
  const userInfo = await this.jwtAuthService.validateToken(token);
  client.user = userInfo;
  // Connection allowed
}
```

---

## Security Checklist

- [x] Token expiration checked automatically
- [x] Token signature verified
- [x] Blacklist checked by JTI (primary)
- [x] Blacklist checked by token string (fallback)
- [x] Blacklist expiration validated
- [x] User existence verified
- [x] User active status checked
- [x] User deleted status checked
- [x] User blocked status checked
- [x] Proper error handling
- [x] Security logging

---

## Summary

✅ **Token Expiration**: Automatically checked by `jwtService.verify()`  
✅ **Blacklist Check**: Primary by JTI, fallback by token string  
✅ **User Validation**: Existence, active, deleted, blocked status  
✅ **Error Handling**: Comprehensive error codes and messages  
✅ **Security**: Multiple layers of validation

The JWT authentication flow is **fully protected** with:

- Automatic expiration checking
- Comprehensive blacklist validation
- Complete user status verification
- Proper error handling and logging

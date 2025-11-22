# Authentication Module

This module provides JWT authentication for WebSocket connections.

## Structure

```
auth/
├── auth.module.ts          # Module definition
├── jwt-auth.service.ts     # JWT token validation service
├── guards/
│   └── ws-jwt.guard.ts    # WebSocket JWT guard
├── types/
│   └── socket.types.ts    # Type definitions for authenticated sockets
└── README.md              # This file
```

## Components

### JwtAuthService

Validates JWT tokens and extracts user information from frontend users.

**Features:**

- Token validation using JWT_SECRET_KEY
- Blacklist checking (frontend_token_blacklist)
- User existence verification (frontendusers table)
- User blocking check
- Token extraction from Socket.IO handshake

**Methods:**

- `validateToken(token: string): Promise<AuthenticatedUser>` - Validates JWT and returns user info
- `extractTokenFromSocket(socket: any): string | null` - Extracts token from socket handshake

### WsJwtGuard

NestJS guard for WebSocket authentication. Can be used with `@UseGuards()` decorator.

**Features:**

- Validates JWT on connection
- Attaches user info to socket
- Joins user-specific rooms
- Throws WsException on auth failure

### Types

**AuthenticatedUser:**

```typescript
{
  userId: number;
  userUuid: string;
  email?: string;
  jti?: string;
}
```

**AuthenticatedSocket:**

- Extends Socket.IO Socket with optional `user` property
- Type guard: `isAuthenticatedSocket(socket)`

## Usage

### In Socket Gateway

```typescript
import { JwtAuthService } from '../auth/jwt-auth.service';

constructor(private readonly jwtAuthService: JwtAuthService) {}

async handleConnection(client: AuthenticatedSocket) {
  const token = this.jwtAuthService.extractTokenFromSocket(client);
  const userInfo = await this.jwtAuthService.validateToken(token);
  client.user = userInfo;
}
```

### With Guard

```typescript
@UseGuards(WsJwtGuard)
@SubscribeMessage('protected-event')
handleProtectedEvent(@ConnectedSocket() client: AuthenticatedSocket) {
  // client.user is guaranteed to exist
  const userId = client.user.userId;
}
```

## Environment Variables

- `JWT_SECRET_KEY` - Secret key for JWT verification (required)
- `JWT_REFRESH_SECRET_KEY` - Secret key for refresh tokens (optional)

## Client Connection

Clients must provide JWT token in one of these ways (checked in priority order):

### 1. **Recommended - Auth Object (Socket.IO v4+)**

```javascript
const socket = io('/ws/v1/session/', {
  auth: {
    token: 'your-jwt-token-here',
  },
});
```

**Example with AsyncStorage (React Native):**

```javascript
import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';

const token = await AsyncStorage.getItem('access_token');

const socket = io('https://your-api.com/ws/v1/session/', {
  transports: ['websocket', 'polling'],
  auth: {
    token: token,
  },
});
```

### 2. **Authorization Header**

```javascript
const socket = io('/ws/v1/session/', {
  extraHeaders: {
    Authorization: 'Bearer your-jwt-token-here',
  },
});
```

### 3. **Query Parameter (Fallback)**

```javascript
const socket = io('/ws/v1/session/', {
  query: {
    token: 'your-jwt-token-here',
  },
});
```

**Note:** The backend automatically checks all three methods in priority order:

1. `auth.token` (Priority 1)
2. `Authorization` header (Priority 2)
3. Query parameter `token` (Priority 3)

## Events

**Client receives:**

- `authenticated` - On successful authentication
- `error` - On authentication failure (with `AUTH_REQUIRED` or `AUTH_FAILED` code)

## Security

- ✅ JWT token validation
- ✅ Token blacklist checking
- ✅ User account status verification
- ✅ Blocked user detection
- ✅ Type-safe authenticated sockets

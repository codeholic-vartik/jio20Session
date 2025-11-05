# Frontend WebSocket Implementation Guide

Complete guide for implementing WebSocket connections in your frontend application with JWT authentication and real-time updates.

## Table of Contents

1. [Installation](#installation)
2. [Basic Connection](#basic-connection)
3. [JWT Authentication](#jwt-authentication)
4. [Event Handling](#event-handling)
5. [Error Handling & Reconnection](#error-handling--reconnection)
6. [Framework Examples](#framework-examples)
7. [TypeScript Types](#typescript-types)
8. [Security Best Practices](#security-best-practices)
9. [Production Considerations](#production-considerations)

---

## Installation

### Install Socket.IO Client

```bash
npm install socket.io-client
```

### TypeScript Types (Optional but Recommended)

```bash
npm install --save-dev @types/socket.io-client
```

---

## Basic Connection

### Configuration

```javascript
import { io } from 'socket.io-client';

const WS_SERVER_URL = process.env.REACT_APP_WS_URL || 'http://localhost:9000';
const WS_NAMESPACE = '/ws/v1/session/';
const WS_URL = `${WS_SERVER_URL}${WS_NAMESPACE}`;
```

---

## JWT Authentication

**⚠️ IMPORTANT:** Always use the `auth` object method (recommended) or `extraHeaders` for production. Avoid query parameters as they may be logged in server access logs.

### Method 1: Auth Object (Recommended - Socket.IO v4+)

```javascript
import { io } from 'socket.io-client';

// Get JWT token from your auth system (localStorage, cookie, context, etc.)
const token = localStorage.getItem('access_token'); // or however you store it

const socket = io(WS_URL, {
  transports: ['websocket', 'polling'], // Try websocket first, fallback to polling
  auth: {
    token: token, // Pass token in auth object
  },
  // Reconnection settings
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5,
});

// Listen for authentication success
socket.on('authenticated', (data) => {
  console.log('Authentication successful:', data);
  // data: { userId: number, userUuid: string, message: string }
});

// Listen for authentication errors
socket.on('error', (error) => {
  if (error.code === 'AUTH_REQUIRED') {
    console.error('Authentication required - token missing');
    // Redirect to login
  } else if (error.code === 'AUTH_FAILED') {
    console.error('Authentication failed:', error.message);
    // Token invalid/expired - refresh token or redirect to login
  }
});
```

### Method 2: Authorization Header

```javascript
const socket = io(WS_URL, {
  transports: ['websocket', 'polling'],
  extraHeaders: {
    Authorization: `Bearer ${token}`, // Include Bearer prefix
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5,
});
```

### Method 3: Query Parameter (⚠️ Less Secure - Use Only for Development)

```javascript
// NOT RECOMMENDED FOR PRODUCTION
const socket = io(WS_URL, {
  transports: ['websocket', 'polling'],
  query: {
    token: token, // May be logged in server access logs
  },
});
```

---

## Event Handling

### Connection Events

```javascript
// Connection established
socket.on('connect', () => {
  console.log('Connected to server:', socket.id);
  // Socket is now connected and authenticated (if token was valid)
});

// Disconnection
socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);

  // Handle different disconnect reasons
  if (reason === 'io server disconnect') {
    // Server initiated disconnect - reconnect manually
    socket.connect();
  } else if (reason === 'io client disconnect') {
    // Client initiated disconnect - don't reconnect
  } else {
    // Network error - will auto-reconnect if reconnection enabled
  }
});

// Connection error
socket.on('connect_error', (error) => {
  console.error('Connection error:', error);

  // Handle authentication errors
  if (error.message.includes('Authentication failed')) {
    // Token invalid - refresh token or redirect to login
    refreshTokenAndReconnect();
  }
});
```

### Real-Time Updates

#### Sales Count Updates

```javascript
socket.on('sales:count:update', (data) => {
  console.log('Sales count updated:', data);

  // data structure:
  // {
  //   session_id: number,
  //   count: number,
  //   session_profile_id?: number,
  //   updated_at: string
  // }

  // Update your UI with the new count
  updateSalesCount(data.session_id, data.count);
});

function updateSalesCount(sessionId, count) {
  // Update your React state, Vue data, or DOM
  // Example:
  setSalesCount(count);
}
```

#### Participant Count Updates

```javascript
socket.on('participant:count:update', (data) => {
  console.log('Participant count updated:', data);

  // data structure:
  // {
  //   suid: string,
  //   participant_count: number,
  //   session_profile_id: number,
  //   session_id?: number,
  //   position?: number,
  //   is_winner?: boolean,
  //   updated_at: string
  // }

  // Update your UI
  updateParticipantCount(data.suid, data.participant_count, data.position);
});

function updateParticipantCount(suid, count, position) {
  // Update your UI state
  setParticipantCount(count);
  if (position !== undefined) {
    setPosition(position);
  }
}
```

### Ping/Pong (Heartbeat)

```javascript
socket.on('ping', () => {
  // Server sent ping - client should respond with pong
  socket.emit('pong', { timestamp: Date.now() });
});
```

---

## Error Handling & Reconnection

### Comprehensive Error Handling

```javascript
class WebSocketManager {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.socket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
  }

  connect() {
    this.socket = io(this.url, {
      transports: ['websocket', 'polling'],
      auth: { token: this.token },
      reconnection: true,
      reconnectionDelay: this.reconnectDelay,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts,
      timeout: 20000, // 20 seconds
    });

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Connection success
    this.socket.on('connect', () => {
      console.log('✅ Connected:', this.socket.id);
      this.reconnectAttempts = 0;
      this.onConnected?.();
    });

    // Authentication success
    this.socket.on('authenticated', (data) => {
      console.log('✅ Authenticated:', data);
      this.onAuthenticated?.(data);
    });

    // Connection error
    this.socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error);

      if (error.message.includes('Authentication')) {
        // Auth error - refresh token
        this.handleAuthError();
      } else {
        // Network error - will auto-reconnect
        this.onConnectionError?.(error);
      }
    });

    // Disconnection
    this.socket.on('disconnect', (reason) => {
      console.log('⚠️ Disconnected:', reason);

      if (reason === 'io server disconnect') {
        // Server closed connection - try to reconnect
        setTimeout(() => this.socket.connect(), 1000);
      }

      this.onDisconnected?.(reason);
    });

    // Reconnection attempt
    this.socket.io.on('reconnect_attempt', (attemptNumber) => {
      console.log(`🔄 Reconnection attempt ${attemptNumber}`);
      this.reconnectAttempts = attemptNumber;
      this.onReconnecting?.(attemptNumber);
    });

    // Reconnection failed
    this.socket.io.on('reconnect_failed', () => {
      console.error('❌ Reconnection failed after all attempts');
      this.onReconnectFailed?.();
    });

    // Error events
    this.socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
      this.onError?.(error);
    });
  }

  async handleAuthError() {
    // Try to refresh token
    try {
      const newToken = await refreshAccessToken();
      if (newToken) {
        this.token = newToken;
        // Reconnect with new token
        this.disconnect();
        this.connect();
      } else {
        // Redirect to login
        window.location.href = '/login';
      }
    } catch (error) {
      console.error('Failed to refresh token:', error);
      window.location.href = '/login';
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // Update token and reconnect
  updateToken(newToken) {
    this.token = newToken;
    if (this.socket) {
      this.disconnect();
      this.connect();
    }
  }

  // Callbacks (set these from your component)
  onConnected = null;
  onAuthenticated = null;
  onDisconnected = null;
  onConnectionError = null;
  onReconnecting = null;
  onReconnectFailed = null;
  onError = null;
}

// Usage
const wsManager = new WebSocketManager(WS_URL, token);
wsManager.onConnected = () => {
  console.log('Socket connected!');
};
wsManager.onAuthenticated = (data) => {
  console.log('User authenticated:', data.userId);
};
wsManager.connect();
```

---

## Framework Examples

See [FRONTEND_EXAMPLES.md](./FRONTEND_EXAMPLES.md) for complete React and Vue.js examples.

---

## TypeScript Types

```typescript
// types/websocket.ts

export interface AuthenticatedResponse {
  userId: number;
  userUuid: string;
  message: string;
}

export interface SocketError {
  message: string;
  code?: 'AUTH_REQUIRED' | 'AUTH_FAILED' | string;
}

export interface SalesCountUpdate {
  session_id: number;
  count: number;
  session_profile_id?: number;
  updated_at: string;
}

export interface ParticipantCountUpdate {
  suid: string;
  participant_count: number;
  session_profile_id: number;
  session_id?: number;
  position?: number;
  is_winner?: boolean;
  updated_at: string;
}

export interface PingPayload {
  timestamp?: number;
}

export interface PongPayload {
  timestamp: number;
}
```

---

## Security Best Practices

### 1. Token Storage

```javascript
// ✅ DO: Use httpOnly cookies (most secure)
// Backend sets httpOnly cookie, frontend doesn't need to handle token

// ✅ DO: Use secure localStorage with expiration
class TokenManager {
  static setToken(token: string, expiresIn: number) {
    const expiresAt = Date.now() + expiresIn * 1000;
    localStorage.setItem('access_token', token);
    localStorage.setItem('token_expires_at', expiresAt.toString());
  }

  static getToken(): string | null {
    const expiresAt = localStorage.getItem('token_expires_at');
    if (expiresAt && Date.now() > parseInt(expiresAt)) {
      // Token expired
      this.clearToken();
      return null;
    }
    return localStorage.getItem('access_token');
  }

  static clearToken() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('token_expires_at');
  }
}

// ❌ DON'T: Store tokens in plain JavaScript variables (lost on refresh)
// ❌ DON'T: Store tokens in regular cookies (vulnerable to XSS)
```

### 2. Token Refresh

```javascript
// Auto-refresh token before expiration
async function refreshTokenIfNeeded() {
  const expiresAt = localStorage.getItem('token_expires_at');
  if (!expiresAt) return null;

  const expiresIn = parseInt(expiresAt) - Date.now();
  const refreshThreshold = 5 * 60 * 1000; // 5 minutes before expiration

  if (expiresIn < refreshThreshold) {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await response.json();

      if (data.access_token) {
        TokenManager.setToken(data.access_token, data.expires_in);
        return data.access_token;
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Redirect to login
      window.location.href = '/login';
    }
  }

  return TokenManager.getToken();
}

// Call before WebSocket connection
const token = await refreshTokenIfNeeded();
```

### 3. Environment Variables

```javascript
// ✅ DO: Use environment variables for URLs
const WS_URL = process.env.REACT_APP_WS_URL || 'http://localhost:9000';

// ❌ DON'T: Hardcode URLs in source code
// const WS_URL = 'http://localhost:9000'; // ❌
```

### 4. HTTPS/WSS in Production

```javascript
// Automatically use WSS in production
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${protocol}//${window.location.host}/ws/v1/session/`;
```

### 5. Error Handling

```javascript
// Always handle authentication errors gracefully
socket.on('error', (error) => {
  if (error.code === 'AUTH_FAILED') {
    // Clear invalid token
    TokenManager.clearToken();
    // Redirect to login (don't show sensitive error messages)
    window.location.href = '/login?error=session_expired';
  }
});
```

---

## Production Considerations

### 1. Connection Pooling

```javascript
// Reuse a single socket connection across your app
class WebSocketSingleton {
  static instance = null;

  static getInstance(url, token) {
    if (!this.instance || !this.instance.socket?.connected) {
      this.instance = new WebSocketManager(url, token);
      this.instance.connect();
    }
    return this.instance;
  }
}

// Use throughout your app
const ws = WebSocketSingleton.getInstance(WS_URL, token);
```

### 2. Rate Limiting

```javascript
// Implement client-side rate limiting for events
class RateLimitedSocket {
  constructor(socket, maxEventsPerSecond = 10) {
    this.socket = socket;
    this.eventQueue = [];
    this.maxEventsPerSecond = maxEventsPerSecond;
    this.lastEventTime = 0;
    this.eventCount = 0;
  }

  emit(event, data) {
    const now = Date.now();
    if (now - this.lastEventTime > 1000) {
      this.eventCount = 0;
      this.lastEventTime = now;
    }

    if (this.eventCount < this.maxEventsPerSecond) {
      this.socket.emit(event, data);
      this.eventCount++;
    } else {
      console.warn(`Rate limit exceeded for event: ${event}`);
    }
  }
}
```

### 3. Monitoring

```javascript
// Track connection metrics
class SocketMonitor {
  constructor(socket) {
    this.socket = socket;
    this.metrics = {
      connectTime: null,
      disconnectCount: 0,
      errorCount: 0,
      messageCount: 0,
    };

    this.setupMonitoring();
  }

  setupMonitoring() {
    this.socket.on('connect', () => {
      this.metrics.connectTime = Date.now();
      this.sendMetric('socket_connected');
    });

    this.socket.on('disconnect', () => {
      this.metrics.disconnectCount++;
      this.sendMetric('socket_disconnected');
    });

    this.socket.on('error', () => {
      this.metrics.errorCount++;
      this.sendMetric('socket_error');
    });

    this.socket.onAny(() => {
      this.metrics.messageCount++;
    });
  }

  sendMetric(event) {
    // Send to your analytics service (e.g., Sentry, LogRocket)
    if (window.analytics) {
      window.analytics.track(event, this.metrics);
    }
  }
}
```

---

## Summary

✅ **Always use JWT authentication via `auth` object or `extraHeaders`**  
✅ **Handle authentication errors and refresh tokens**  
✅ **Implement proper reconnection logic**  
✅ **Use TypeScript for type safety**  
✅ **Handle all events properly**  
✅ **Monitor connection health**  
✅ **Use HTTPS/WSS in production**  
✅ **Store tokens securely**

For questions or issues, refer to the [Socket.IO Client Documentation](https://socket.io/docs/v4/client-api/).

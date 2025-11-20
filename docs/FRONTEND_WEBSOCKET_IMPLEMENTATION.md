# Frontend WebSocket Implementation Guide

Complete guide for implementing WebSocket connections in your frontend application with JWT authentication and real-time updates.

## Table of Contents

1. [Overview & Architecture](#overview--architecture)
2. [Installation](#installation)
3. [Basic Connection](#basic-connection)
4. [JWT Authentication](#jwt-authentication)
5. [Complete Flow Diagrams](#complete-flow-diagrams)
6. [User Join Flow](#user-join-flow)
7. [Session Sales Join Flow](#session-sales-join-flow)
8. [Event Handling](#event-handling)
9. [Sales Count Context](#sales-count-context)
10. [Participant Count Updates](#participant-count-updates)
11. [Error Handling & Reconnection](#error-handling--reconnection)
12. [React App Examples](#react-app-examples)
13. [TypeScript Types](#typescript-types)
14. [Security Best Practices](#security-best-practices)
15. [Production Considerations](#production-considerations)

---

## Overview & Architecture

### System Architecture

The WebSocket system uses **Socket.IO** with **Redis adapter** for horizontal scaling. It provides real-time updates for:

- **Sales Count Updates**: Real-time sales count for sessions and taxonomy terms
- **Participant Count Updates**: Live participant counts with position tracking
- **Session Status Updates**: Session lifecycle events (created, active, completed)
- **Taxonomy Sales**: Aggregated sales data across multiple sessions by taxonomy term

### Key Components

1. **Socket Gateway** (`/ws/v1/session/`): Main WebSocket namespace
2. **Redis Pub/Sub**: Backend event broadcasting system
3. **JWT Authentication**: Token-based authentication on connection
4. **Room-based Broadcasting**: Efficient message routing using Socket.IO rooms

### Quick Reference

#### Connection

```javascript
const socket = io(WS_URL, {
  auth: { token: userToken },
  transports: ['websocket', 'polling'],
});
```

#### Join Session Sales

```javascript
socket.emit('session:sales:count', {
  taxonomy_term_id: 'tmuid_123',
});

const roomEvent = `session:sales:tmuid_123`;
socket.on(roomEvent, (data) => {
  // Initial snapshot or real-time update
});
```

#### Listen to Participant Updates

```javascript
socket.on('participant:count:update', (data) => {
  // { suid, participant_count, position, is_winner }
});
```

#### Events Summary

| Event                      | Direction       | Description                     |
| -------------------------- | --------------- | ------------------------------- |
| `authenticated`            | Server → Client | Authentication successful       |
| `error`                    | Server → Client | Error occurred                  |
| `session:sales:count`      | Client → Server | Join taxonomy sales room        |
| `session:sales:{tmuid}`    | Server → Client | Sales updates for taxonomy term |
| `participant:count:update` | Server → Client | Participant count updates       |
| `ping`                     | Client → Server | Heartbeat ping                  |
| `pong`                     | Server → Client | Heartbeat response              |

### Connection Flow

```
Frontend App
    ↓
Connect to /ws/v1/session/
    ↓
Send JWT Token (auth object)
    ↓
Server validates token
    ↓
Auto-join user rooms (user:userId, user:userUuid)
    ↓
Receive 'authenticated' event
    ↓
Ready to send/receive events
```

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

## Complete Flow Diagrams

### Mind Map: WebSocket Event Flow

```
WebSocket Connection
│
├── Connection Phase
│   ├── Connect to /ws/v1/session/
│   ├── Send JWT Token
│   ├── Server Authentication
│   ├── Auto-join user rooms
│   └── Receive 'authenticated' event
│
├── Session Sales Flow
│   ├── Emit 'session:sales:count' with taxonomy_term_id
│   ├── Server builds sales snapshot
│   ├── Join taxonomy sales room (session:sales:{tmuid})
│   ├── Receive initial snapshot on room event
│   └── Listen to room for real-time updates
│
├── Real-Time Updates (Server → Client)
│   ├── Sales Count Updates
│   │   ├── Event: session:sales:{tmuid}
│   │   ├── Payload: { ss, psr, psl, ca }
│   │   └── Context: Session status, percentage reached/left
│   │
│   └── Participant Updates
│       ├── Event: participant:count:update
│       ├── Payload: { suid, participant_count, position, is_winner }
│       └── Context: User position in queue, winner status
│
└── Utility Events
    ├── Ping/Pong (heartbeat)
    └── Error handling
```

### Complete User Journey Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    USER JOURNEY FLOW                         │
└─────────────────────────────────────────────────────────────┘

1. USER OPENS APP
   │
   ├─→ Get JWT Token (localStorage/cookie)
   │
   └─→ Initialize Socket Connection
       │
       ├─→ Connect to /ws/v1/session/
       ├─→ Send token in auth object
       └─→ Wait for authentication

2. AUTHENTICATION
   │
   ├─→ Server validates JWT
   │
   ├─→ Auto-join user rooms:
   │   ├─→ user:{userId}
   │   └─→ user:{userUuid}
   │
   └─→ Receive 'authenticated' event
       │
       └─→ Connection ready!

3. JOIN SESSION SALES (User Action)
   │
   ├─→ User navigates to session/taxonomy page
   │
   ├─→ Emit 'session:sales:count' event:
   │   {
   │     taxonomy_term_id: "tmuid_123"
   │   }
   │
   ├─→ Server processes:
   │   ├─→ Builds sales snapshot
   │   ├─→ Joins room: session:sales:{tmuid}
   │   └─→ Returns initial data
   │
   └─→ Receive initial snapshot on room event:
       │
       └─→ Display: sales count, sessions, profiles

4. REAL-TIME UPDATES (Automatic)
   │
   ├─→ Sales Count Updates
   │   │
   │   ├─→ Backend publishes to Redis
   │   │
   │   ├─→ Redis Subscriber receives update
   │   │
   │   ├─→ Broadcasts to room: session:sales:{tmuid}
   │   │
   │   └─→ Frontend receives update:
   │       {
   │         ss: "ACTIVE",           // Session status
   │         psr: 75,                // Percentage sale reached
   │         psl: 25,                // Percentage sale left
   │         ca: "2024-01-01T..."    // Created at
   │       }
   │
   └─→ Participant Updates
       │
       ├─→ Backend publishes to Redis
       │
       ├─→ Redis Subscriber receives update
       │
       ├─→ Broadcasts to all clients
       │
       └─→ Frontend receives update:
           {
             suid: "session_123",
             participant_count: 150,
             position: 42,
             is_winner: false,
             session_profile_id: 456
           }

5. USER LEAVES
   │
   └─→ Socket disconnects
       │
       └─→ Auto-cleanup (Socket.IO handles)
```

---

## User Join Flow

### Step-by-Step User Join Process

When a user connects to the WebSocket, the following happens automatically:

```javascript
// 1. User initiates connection
const socket = io(WS_URL, {
  auth: { token: userToken },
  transports: ['websocket', 'polling'],
});

// 2. Connection established
socket.on('connect', () => {
  console.log('Connected:', socket.id);
  // Socket is connected but not yet authenticated
});

// 3. Authentication happens automatically
socket.on('authenticated', (data) => {
  console.log('Authenticated:', data);
  // {
  //   userId: 123,
  //   userUuid: "uuid-456",
  //   message: "Successfully authenticated"
  // }

  // User is now automatically in these rooms:
  // - user:123
  // - user:uuid-456

  // Ready to send/receive events!
});
```

### What Happens on the Backend

1. **Token Extraction**: Server extracts JWT from `auth.token` or `Authorization` header
2. **Token Validation**: JWT is validated against secret key
3. **User Info Extraction**: User ID and UUID extracted from token
4. **Room Joining**: User automatically joins:
   - `user:{userId}` - For user-specific messages
   - `user:{userUuid}` - Alternative user identifier room
5. **Authentication Event**: Server emits `authenticated` event with user info

### User Room Usage

User rooms allow targeted messaging to specific users across all their connections:

```javascript
// Backend can send user-specific messages
server.to('user:123').emit('custom:event', data);

// Frontend automatically receives if connected
socket.on('custom:event', (data) => {
  // Handle user-specific message
});
```

---

## Session Sales Join Flow

### Complete Session Sales Join Process

To receive real-time sales updates for a taxonomy term (category), you need to join the taxonomy sales room:

```javascript
// 1. User wants to view sales for a taxonomy term
const taxonomyTermId = 'tmuid_abc123'; // Taxonomy term UID

// 2. Emit join request
socket.emit('session:sales:count', {
  taxonomy_term_id: taxonomyTermId,
  // Optional: session_id or session_profile_id can also be provided
});

// 3. Server processes request
// - Validates taxonomy term exists
// - Builds sales snapshot (aggregated data)
// - Joins client to room: session:sales:{tmuid}
// - Returns initial snapshot

// 4. Receive initial snapshot on room-specific event
const roomEvent = `session:sales:${taxonomyTermId}`;
socket.on(roomEvent, (data) => {
  console.log('Initial sales snapshot:', data);
  // {
  //   taxonomy_term: {
  //     title: "Electronics",
  //     description: "Electronic products",
  //     tmuid: "tmuid_abc123"
  //   },
  //   sales_count: 1250,
  //   session_profiles: [
  //     {
  //       title: "Product A",
  //       spuid: "spuid_xyz",
  //       is_active: true
  //     }
  //   ],
  //   sessions: [
  //     {
  //       suid: "session_123",
  //       title: "Session 1",
  //       status: "ACTIVE",
  //       current_sales_count: 500,
  //       current_participant_count: 200
  //     }
  //   ],
  //   updated_at: "2024-01-01T12:00:00Z"
  // }
});

// 5. Listen for real-time updates on the same room event
socket.on(roomEvent, (update) => {
  // This will fire for both initial snapshot and updates
  console.log('Sales update:', update);
  // Update format:
  // {
  //   ss: "ACTIVE",        // Session status
  //   psr: 75,             // Percentage sale reached (0-100)
  //   psl: 25,             // Percentage sale left (0-100)
  //   ca: "2024-01-01..."  // Created at timestamp
  // }
});
```

### Session Sales Payload Structure

**Request Payload** (Client → Server):

```typescript
interface SessionSalesRequest {
  taxonomy_term_id?: string; // Required for taxonomy sales
  session_id?: string; // Optional
  session_profile_id?: string; // Optional
}
```

**Response Payload** (Server → Client):

```typescript
interface TaxonomySalesSnapshot {
  taxonomy_term: {
    title: string;
    description: string;
    tmuid: string;
  };
  sales_count: number;
  session_profiles: Array<{
    title: string;
    description: string;
    spuid: string;
    is_active: boolean;
  }>;
  sessions: Array<{
    suid: string;
    title: string;
    description: string;
    status: string;
    current_sales_count: number;
    current_participant_count: number;
  }>;
  updated_at: string;
}
```

**Real-Time Update Payload** (Server → Client):

```typescript
interface SalesCountUpdate {
  ss: string; // Session status (ACTIVE, COMPLETED, etc.)
  psr: number; // Percentage sale reached (0-100)
  psl: number; // Percentage sale left (0-100)
  ca: string; // Created at (ISO timestamp)
}
```

### Room Naming Convention

Rooms follow this pattern:

- **Taxonomy Sales Room**: `session:sales:{tmuid}`
  - Example: `session:sales:tmuid_abc123`
- **Session Room**: `session:{sessionId}`
- **User Room**: `user:{userId}` or `user:{userUuid}`

The room name is also used as the event name for receiving updates!

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

#### Sales Count Updates (Taxonomy Sales Room)

After joining a taxonomy sales room, you receive updates on the room-specific event:

```javascript
// After joining with: socket.emit('session:sales:count', { taxonomy_term_id: 'tmuid_123' })
const taxonomyTermId = 'tmuid_123';
const roomEvent = `session:sales:${taxonomyTermId}`;

socket.on(roomEvent, (data) => {
  // First call: Initial snapshot (full data)
  if (data.taxonomy_term) {
    console.log('Initial snapshot:', data);
    // Full TaxonomySalesSnapshot structure
  }
  // Subsequent calls: Real-time updates (compact format)
  else {
    console.log('Sales update:', data);
    // {
    //   ss: "ACTIVE",        // Session status
    //   psr: 75,             // Percentage sale reached
    //   psl: 25,             // Percentage sale left
    //   ca: "2024-01-01..."  // Created at
    // }

    updateSalesProgress(data.psr, data.psl, data.ss);
  }
});

function updateSalesProgress(percentageReached, percentageLeft, status) {
  // Update progress bar
  setProgressReached(percentageReached);
  setProgressLeft(percentageLeft);
  setSessionStatus(status);
}
```

#### Participant Count Updates

Participant updates are broadcast to all connected clients:

```javascript
socket.on('participant:count:update', (data) => {
  console.log('Participant count updated:', data);

  // data structure:
  // {
  //   suid: string,                    // Session unique ID
  //   participant_count: number,        // Total participants
  //   session_profile_id: number,       // Profile ID
  //   session_id?: number,              // Optional session ID
  //   position?: number,                // User's position in queue
  //   is_winner?: boolean,              // Winner status
  //   updated_at: string                // ISO timestamp
  // }

  // Filter by session if needed
  if (data.suid === currentSessionId) {
    updateParticipantCount(
      data.participant_count,
      data.position,
      data.is_winner,
    );
  }
});

function updateParticipantCount(count, position, isWinner) {
  setParticipantCount(count);
  if (position !== undefined) {
    setUserPosition(position);
  }
  if (isWinner !== undefined) {
    setIsWinner(isWinner);
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

## Sales Count Context

### Understanding Sales Count Updates

Sales count updates provide context about session progress and availability:

#### Update Payload Fields

```typescript
interface SalesCountUpdate {
  ss: string; // Session Status
  // Possible values: "ACTIVE", "COMPLETED", "PENDING", "CANCELLED"

  psr: number; // Percentage Sale Reached (0-100)
  // How much of the sale has been completed

  psl: number; // Percentage Sale Left (0-100)
  // How much of the sale is remaining

  ca: string; // Created At (ISO 8601 timestamp)
  // When the update was generated
}
```

#### Usage Example

```javascript
socket.on(`session:sales:${taxonomyTermId}`, (update) => {
  const { ss, psr, psl, ca } = update;

  // Update UI based on status
  switch (ss) {
    case 'ACTIVE':
      // Show active session UI
      showActiveSession(psr, psl);
      break;
    case 'COMPLETED':
      // Show completed session UI
      showCompletedSession();
      break;
    case 'PENDING':
      // Show pending session UI
      showPendingSession();
      break;
  }

  // Update progress indicators
  updateProgressBar(psr);
  updateRemainingCount(psl);

  // Show timestamp
  displayLastUpdate(ca);
});
```

### Session Status Values

- **ACTIVE**: Session is currently active and accepting participants
- **COMPLETED**: Session has reached its sales threshold and is complete
- **PENDING**: Session is waiting to start
- **CANCELLED**: Session has been cancelled

---

## Participant Count Updates

### Understanding Participant Updates

Participant updates track user position in queues and winner status:

#### Update Payload Fields

```typescript
interface ParticipantUpdate {
  suid: string; // Session Unique ID
  participant_count: number; // Total number of participants
  session_profile_id: number; // Session profile ID
  session_id?: number; // Optional numeric session ID
  position?: number; // User's position in queue (1-based)
  is_winner?: boolean; // Whether user is a winner
  updated_at: string; // ISO 8601 timestamp
}
```

#### Usage Example

```javascript
socket.on('participant:count:update', (data) => {
  const { suid, participant_count, position, is_winner, session_profile_id } =
    data;

  // Update participant count display
  setTotalParticipants(participant_count);

  // Show user's position if available
  if (position !== undefined) {
    setUserPosition(position);
    showPositionBadge(position);
  }

  // Handle winner status
  if (is_winner === true) {
    showWinnerNotification();
    enableWinnerActions();
  }

  // Update session-specific UI
  if (suid === currentSessionId) {
    updateSessionParticipantCount(participant_count);
  }
});
```

### Position Tracking

- **Position** is 1-based (first participant = 1)
- **Position** is only included when the user is a participant
- **is_winner** indicates if the user won a spot in the session

---

## React App Examples

### Complete React Hook with Session Sales

```typescript
// hooks/useSessionSales.ts
import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface UseSessionSalesOptions {
  url: string;
  token: string | null;
  taxonomyTermId: string | null;
  enabled?: boolean;
}

interface TaxonomySalesSnapshot {
  taxonomy_term: {
    title: string;
    description: string;
    tmuid: string;
  };
  sales_count: number;
  session_profiles: Array<{
    title: string;
    spuid: string;
    is_active: boolean;
  }>;
  sessions: Array<{
    suid: string;
    title: string;
    status: string;
    current_sales_count: number;
    current_participant_count: number;
  }>;
  updated_at: string;
}

interface SalesCountUpdate {
  ss: string;
  psr: number;
  psl: number;
  ca: string;
}

export function useSessionSales(options: UseSessionSalesOptions) {
  const { url, token, taxonomyTermId, enabled = true } = options;
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [snapshot, setSnapshot] = useState<TaxonomySalesSnapshot | null>(null);
  const [salesUpdate, setSalesUpdate] = useState<SalesCountUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize socket connection
  useEffect(() => {
    if (!enabled || !token) return;

    const socket = io(url, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setError(null);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('authenticated', () => {
      setIsAuthenticated(true);
    });

    socket.on('error', (err: { message: string; code?: string }) => {
      setError(err.message);
      if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_FAILED') {
        setIsAuthenticated(false);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setIsAuthenticated(false);
    };
  }, [url, token, enabled]);

  // Join taxonomy sales room when authenticated and taxonomyTermId is available
  useEffect(() => {
    if (!socketRef.current || !isAuthenticated || !taxonomyTermId) return;

    const socket = socketRef.current;
    const roomEvent = `session:sales:${taxonomyTermId}`;

    // Emit join request
    socket.emit('session:sales:count', {
      taxonomy_term_id: taxonomyTermId,
    });

    // Listen for updates on room event
    const handleUpdate = (data: TaxonomySalesSnapshot | SalesCountUpdate) => {
      // Check if it's initial snapshot (has taxonomy_term) or update
      if ('taxonomy_term' in data) {
        setSnapshot(data as TaxonomySalesSnapshot);
      } else {
        setSalesUpdate(data as SalesCountUpdate);
      }
    };

    socket.on(roomEvent, handleUpdate);

    return () => {
      socket.off(roomEvent, handleUpdate);
    };
  }, [isAuthenticated, taxonomyTermId]);

  return {
    socket: socketRef.current,
    isConnected,
    isAuthenticated,
    snapshot,
    salesUpdate,
    error,
  };
}
```

### Using the Hook in a Component

```typescript
// components/SessionSalesView.tsx
'use client';

import { useSessionSales } from '@/hooks/useSessionSales';

export function SessionSalesView({ taxonomyTermId }: { taxonomyTermId: string }) {
  const token = typeof window !== 'undefined'
    ? localStorage.getItem('access_token')
    : null;

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';

  const {
    isConnected,
    isAuthenticated,
    snapshot,
    salesUpdate,
    error
  } = useSessionSales({
    url: WS_URL,
    token,
    taxonomyTermId,
    enabled: !!token,
  });

  if (!isConnected) {
    return <div>Connecting...</div>;
  }

  if (!isAuthenticated) {
    return <div>Authentication required</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">
        {snapshot?.taxonomy_term.title || 'Loading...'}
      </h2>

      {snapshot && (
        <div className="mb-6">
          <div className="text-lg">
            Total Sales: {snapshot.sales_count}
          </div>
          <div className="text-sm text-gray-600">
            Last updated: {new Date(snapshot.updated_at).toLocaleString()}
          </div>
        </div>
      )}

      {salesUpdate && (
        <div className="mb-6">
          <div className="text-lg">
            Status: {salesUpdate.ss}
          </div>
          <div className="w-full bg-gray-200 rounded-full h-4">
            <div
              className="bg-blue-600 h-4 rounded-full"
              style={{ width: `${salesUpdate.psr}%` }}
            />
          </div>
          <div className="text-sm mt-2">
            {salesUpdate.psr}% reached, {salesUpdate.psl}% remaining
          </div>
        </div>
      )}

      {snapshot && snapshot.sessions.length > 0 && (
        <div>
          <h3 className="text-xl font-semibold mb-2">Sessions</h3>
          <div className="space-y-2">
            {snapshot.sessions.map((session) => (
              <div key={session.suid} className="border p-4 rounded">
                <div className="font-semibold">{session.title}</div>
                <div className="text-sm">
                  Status: {session.status} |
                  Sales: {session.current_sales_count} |
                  Participants: {session.current_participant_count}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

### React Context Provider for Global Socket

```typescript
// providers/WebSocketProvider.tsx
'use client';

import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface WebSocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  joinSessionSales: (taxonomyTermId: string) => void;
  onParticipantUpdate: (callback: (data: any) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextType>({
  socket: null,
  isConnected: false,
  isAuthenticated: false,
  joinSessionSales: () => {},
  onParticipantUpdate: () => () => {},
});

export function WebSocketProvider({
  children,
  url,
  token,
}: {
  children: React.ReactNode;
  url: string;
  token: string | null;
}) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const joinedRoomsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;

    const newSocket = io(url, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('authenticated', () => {
      setIsAuthenticated(true);
    });

    newSocket.on('error', (error: { code?: string }) => {
      if (error.code === 'AUTH_FAILED') {
        setIsAuthenticated(false);
      }
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      joinedRoomsRef.current.clear();
    };
  }, [url, token]);

  const joinSessionSales = (taxonomyTermId: string) => {
    if (!socket || !isAuthenticated) return;

    const roomKey = `session:sales:${taxonomyTermId}`;

    // Avoid duplicate joins
    if (joinedRoomsRef.current.has(roomKey)) return;

    socket.emit('session:sales:count', {
      taxonomy_term_id: taxonomyTermId,
    });

    joinedRoomsRef.current.add(roomKey);
  };

  const onParticipantUpdate = (callback: (data: any) => void) => {
    if (!socket) return () => {};

    socket.on('participant:count:update', callback);

    return () => {
      socket.off('participant:count:update', callback);
    };
  };

  return (
    <WebSocketContext.Provider
      value={{
        socket,
        isConnected,
        isAuthenticated,
        joinSessionSales,
        onParticipantUpdate,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}

export const useWebSocketContext = () => useContext(WebSocketContext);
```

---

## Framework Examples

See [FRONTEND_EXAMPLES.md](./FRONTEND_EXAMPLES.md) for complete React and Vue.js examples.

---

## TypeScript Types

Complete TypeScript type definitions for all WebSocket events:

```typescript
// types/websocket.ts

// ============================================
// Authentication Types
// ============================================

export interface AuthenticatedResponse {
  userId: number;
  userUuid: string;
  message: string;
}

export interface SocketError {
  message: string;
  code?:
    | 'AUTH_REQUIRED'
    | 'AUTH_FAILED'
    | 'INVALID_REQUEST'
    | 'TAXONOMY_NOT_FOUND'
    | string;
}

// ============================================
// Session Sales Types
// ============================================

export interface SessionSalesRequest {
  taxonomy_term_id?: string; // Required for taxonomy sales
  session_id?: string; // Optional
  session_profile_id?: string; // Optional
  count?: number; // Optional
}

export interface TaxonomyTerm {
  title: string;
  description: string;
  tmuid: string;
}

export interface SessionProfile {
  title: string;
  description: string;
  spuid: string;
  is_active: boolean;
}

export interface SessionInfo {
  suid: string;
  title: string;
  description: string;
  status: string;
  current_sales_count: number;
  current_participant_count: number;
}

export interface TaxonomySalesSnapshot {
  taxonomy_term: TaxonomyTerm;
  sales_count: number;
  session_profiles: SessionProfile[];
  sessions: SessionInfo[];
  updated_at: string;
}

export interface SalesCountUpdate {
  ss: string; // Session status (ACTIVE, COMPLETED, PENDING, CANCELLED)
  psr: number; // Percentage sale reached (0-100)
  psl: number; // Percentage sale left (0-100)
  ca: string; // Created at (ISO 8601 timestamp)
}

// ============================================
// Participant Types
// ============================================

export interface ParticipantCountUpdate {
  suid: string; // Session unique ID
  participant_count: number; // Total participants
  session_profile_id: number; // Session profile ID
  session_id?: number; // Optional numeric session ID
  position?: number; // User's position in queue (1-based)
  is_winner?: boolean; // Winner status
  updated_at: string; // ISO 8601 timestamp
}

// ============================================
// Ping/Pong Types
// ============================================

export interface PingPayload {
  timestamp?: number;
}

export interface PongPayload {
  timestamp: number;
  userId?: number;
  userUuid?: string;
}

// ============================================
// Socket Event Names
// ============================================

export const SOCKET_EVENTS = {
  // Client -> Server
  PING: 'ping',
  SESSION_SALES: 'session:sales:count',

  // Server -> Client
  AUTHENTICATED: 'authenticated',
  PONG: 'pong',
  ERROR: 'error',
  PARTICIPANT_COUNT_UPDATE: 'participant:count:update',
} as const;

// ============================================
// Room Event Names
// ============================================

export function getTaxonomySalesRoomEvent(taxonomyTermId: string): string {
  return `session:sales:${taxonomyTermId}`;
}

// ============================================
// Socket Connection Options
// ============================================

export interface SocketConnectionOptions {
  url: string;
  token: string | null;
  transports?: ('websocket' | 'polling')[];
  reconnection?: boolean;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  reconnectionAttempts?: number;
}
```

### Usage Example with Types

```typescript
import {
  Socket,
  AuthenticatedResponse,
  TaxonomySalesSnapshot,
  SalesCountUpdate,
  ParticipantCountUpdate,
  getTaxonomySalesRoomEvent,
} from '@/types/websocket';
import { io } from 'socket.io-client';

const socket: Socket = io(WS_URL, {
  auth: { token: userToken },
});

// Typed event handlers
socket.on('authenticated', (data: AuthenticatedResponse) => {
  console.log('User authenticated:', data.userId);
});

socket.on('error', (error: SocketError) => {
  if (error.code === 'AUTH_FAILED') {
    // Handle auth failure
  }
});

// Typed room events
const taxonomyTermId = 'tmuid_123';
const roomEvent = getTaxonomySalesRoomEvent(taxonomyTermId);

socket.on(roomEvent, (data: TaxonomySalesSnapshot | SalesCountUpdate) => {
  if ('taxonomy_term' in data) {
    // Initial snapshot
    const snapshot = data as TaxonomySalesSnapshot;
    console.log('Snapshot:', snapshot.sales_count);
  } else {
    // Real-time update
    const update = data as SalesCountUpdate;
    console.log('Update:', update.psr, '% reached');
  }
});

// Typed participant updates
socket.on('participant:count:update', (data: ParticipantCountUpdate) => {
  console.log('Participants:', data.participant_count);
  if (data.position) {
    console.log('Position:', data.position);
  }
});
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

### Key Takeaways

✅ **Always use JWT authentication via `auth` object or `extraHeaders`**  
✅ **Handle authentication errors and refresh tokens**  
✅ **Implement proper reconnection logic**  
✅ **Use TypeScript for type safety**  
✅ **Handle all events properly**  
✅ **Monitor connection health**  
✅ **Use HTTPS/WSS in production**  
✅ **Store tokens securely**

### Complete Flow Checklist

1. **Connection Setup**

   - [ ] Install `socket.io-client`
   - [ ] Configure WebSocket URL
   - [ ] Set up JWT token retrieval
   - [ ] Initialize socket connection with auth

2. **Authentication**

   - [ ] Listen for `authenticated` event
   - [ ] Handle `error` events (AUTH_REQUIRED, AUTH_FAILED)
   - [ ] Implement token refresh logic

3. **Join Session Sales**

   - [ ] Emit `session:sales:count` with `taxonomy_term_id`
   - [ ] Listen to room event: `session:sales:{tmuid}`
   - [ ] Handle initial snapshot
   - [ ] Handle real-time updates (ss, psr, psl, ca)

4. **Participant Updates**

   - [ ] Listen to `participant:count:update` event
   - [ ] Handle position tracking
   - [ ] Handle winner status

5. **Error Handling**
   - [ ] Handle connection errors
   - [ ] Handle reconnection
   - [ ] Handle authentication failures
   - [ ] Handle network disconnections

### Common Patterns

#### Pattern 1: Basic Connection

```javascript
const socket = io(WS_URL, { auth: { token } });
socket.on('authenticated', () => {
  /* ready */
});
```

#### Pattern 2: Join Taxonomy Sales

```javascript
socket.emit('session:sales:count', { taxonomy_term_id: 'tmuid_123' });
socket.on('session:sales:tmuid_123', (data) => {
  /* updates */
});
```

#### Pattern 3: React Hook Pattern

```javascript
const { snapshot, salesUpdate } = useSessionSales({
  url: WS_URL,
  token,
  taxonomyTermId: 'tmuid_123',
});
```

### Troubleshooting

| Issue                 | Solution                                                 |
| --------------------- | -------------------------------------------------------- |
| Connection fails      | Check WS_URL, verify token is valid                      |
| Not receiving updates | Ensure you've joined the room with `session:sales:count` |
| Auth errors           | Verify token format, check expiration                    |
| Updates not showing   | Check room event name matches taxonomy term ID           |

### Additional Resources

- [Socket.IO Client Documentation](https://socket.io/docs/v4/client-api/)
- [Frontend Examples](./FRONTEND_EXAMPLES.md) - Complete React/Vue examples
- [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) - System architecture details
- [WebSocket Scaling](./WEBSOCKET_SCALING.md) - Scaling considerations

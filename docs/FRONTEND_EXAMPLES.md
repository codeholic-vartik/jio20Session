# Frontend WebSocket Examples - Next.js

Complete, production-ready examples for Next.js applications using both App Router and Pages Router.

## Next.js App Router Examples

### Custom Hook for WebSocket

```typescript
// app/hooks/useWebSocket.ts
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

interface UseWebSocketOptions {
  url: string;
  token: string | null;
  enabled?: boolean;
}

interface SalesUpdate {
  session_id: number;
  count: number;
  session_profile_id?: number;
  updated_at: string;
}

interface ParticipantUpdate {
  suid: string;
  participant_count: number;
  session_profile_id: number;
  session_id?: number;
  position?: number;
  is_winner?: boolean;
  updated_at: string;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { url, token, enabled = true } = options;
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      if (reason === 'io server disconnect') {
        socket.connect();
      }
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

  const onSalesUpdate = useCallback((callback: (data: SalesUpdate) => void) => {
    socketRef.current?.on('sales:count:update', callback);
    return () => socketRef.current?.off('sales:count:update', callback);
  }, []);

  const onParticipantUpdate = useCallback(
    (callback: (data: ParticipantUpdate) => void) => {
      socketRef.current?.on('participant:count:update', callback);
      return () => socketRef.current?.off('participant:count:update', callback);
    },
    [],
  );

  return {
    socket: socketRef.current,
    isConnected,
    isAuthenticated,
    error,
    onSalesUpdate,
    onParticipantUpdate,
  };
}
```

### Using the Hook in a Client Component

```typescript
// app/sessions/[id]/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useWebSocket } from '@/app/hooks/useWebSocket';

export default function SessionPage() {
  const params = useParams();
  const sessionId = parseInt(params.id as string);
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;

  const [salesCount, setSalesCount] = useState(0);
  const [participantCount, setParticipantCount] = useState(0);

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';

  const { isConnected, isAuthenticated, onSalesUpdate, onParticipantUpdate } = useWebSocket({
    url: WS_URL,
    token,
    enabled: !!token,
  });

  useEffect(() => {
    const cleanupSales = onSalesUpdate((data) => {
      if (data.session_id === sessionId) {
        setSalesCount(data.count);
      }
    });

    const cleanupParticipant = onParticipantUpdate((data) => {
      setParticipantCount(data.participant_count);
    });

    return () => {
      cleanupSales();
      cleanupParticipant();
    };
  }, [onSalesUpdate, onParticipantUpdate, sessionId]);

  return (
    <div className="p-6">
      <div className="mb-4">
        <div>Status: {isConnected ? '✅ Connected' : '❌ Disconnected'}</div>
        <div>Auth: {isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}</div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-gray-100 rounded">
          <h3 className="font-bold">Sales Count</h3>
          <p className="text-2xl">{salesCount}</p>
        </div>
        <div className="p-4 bg-gray-100 rounded">
          <h3 className="font-bold">Participants</h3>
          <p className="text-2xl">{participantCount}</p>
        </div>
      </div>
    </div>
  );
}
```

### Context Provider for Global Socket Instance

```typescript
// app/providers/WebSocketProvider.tsx
'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface WebSocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  isAuthenticated: boolean;
}

const WebSocketContext = createContext<WebSocketContextType>({
  socket: null,
  isConnected: false,
  isAuthenticated: false,
});

export function WebSocketProvider({
  children,
  url,
  token
}: {
  children: React.ReactNode;
  url: string;
  token: string | null
}) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

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
    };
  }, [url, token]);

  return (
    <WebSocketContext.Provider value={{ socket, isConnected, isAuthenticated }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export const useWebSocketContext = () => useContext(WebSocketContext);
```

### App Layout with Provider

```typescript
// app/layout.tsx
import { WebSocketProvider } from './providers/WebSocketProvider';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';

  // Get token from cookies or localStorage (depending on your auth setup)
  const token = typeof window !== 'undefined'
    ? localStorage.getItem('access_token')
    : null;

  return (
    <html lang="en">
      <body>
        <WebSocketProvider url={WS_URL} token={token}>
          {children}
        </WebSocketProvider>
      </body>
    </html>
  );
}
```

### Using Context in Components

```typescript
// app/components/SessionStats.tsx
'use client';

import { useEffect, useState } from 'react';
import { useWebSocketContext } from '@/app/providers/WebSocketProvider';

interface SalesUpdate {
  session_id: number;
  count: number;
  updated_at: string;
}

export function SessionStats({ sessionId }: { sessionId: number }) {
  const { socket, isConnected, isAuthenticated } = useWebSocketContext();
  const [salesCount, setSalesCount] = useState(0);

  useEffect(() => {
    if (!socket) return;

    const handleSalesUpdate = (data: SalesUpdate) => {
      if (data.session_id === sessionId) {
        setSalesCount(data.count);
      }
    };

    socket.on('sales:count:update', handleSalesUpdate);

    return () => {
      socket.off('sales:count:update', handleSalesUpdate);
    };
  }, [socket, sessionId]);

  if (!isConnected) {
    return <div>Connecting...</div>;
  }

  if (!isAuthenticated) {
    return <div>Authentication required</div>;
  }

  return (
    <div>
      <div>Sales: {salesCount}</div>
    </div>
  );
}
```

## Next.js Pages Router Examples

### Custom Hook (Same as App Router)

```typescript
// hooks/useWebSocket.ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// ... (same implementation as App Router example above)
```

### Using in a Page Component

```typescript
// pages/sessions/[id].tsx
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useWebSocket } from '@/hooks/useWebSocket';

export default function SessionPage() {
  const router = useRouter();
  const { id } = router.query;
  const sessionId = parseInt(id as string);

  const token = typeof window !== 'undefined'
    ? localStorage.getItem('access_token')
    : null;

  const [salesCount, setSalesCount] = useState(0);

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';

  const { isConnected, isAuthenticated, onSalesUpdate } = useWebSocket({
    url: WS_URL,
    token,
    enabled: !!token,
  });

  useEffect(() => {
    const cleanup = onSalesUpdate((data) => {
      if (data.session_id === sessionId) {
        setSalesCount(data.count);
      }
    });

    return cleanup;
  }, [onSalesUpdate, sessionId]);

  return (
    <div>
      <h1>Session {sessionId}</h1>
      <div>Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
      <div>Sales: {salesCount}</div>
    </div>
  );
}
```

### \_app.tsx with Provider

```typescript
// pages/_app.tsx
import type { AppProps } from 'next/app';
import { WebSocketProvider } from '@/providers/WebSocketProvider';

export default function App({ Component, pageProps }: AppProps) {
  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';
  const token = typeof window !== 'undefined'
    ? localStorage.getItem('access_token')
    : null;

  return (
    <WebSocketProvider url={WS_URL} token={token}>
      <Component {...pageProps} />
    </WebSocketProvider>
  );
}
```

## Environment Variables

Create `.env.local` for Next.js:

```bash
# .env.local
NEXT_PUBLIC_WS_URL=http://localhost:9000
# or for production:
# NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com
```

**Note:** In Next.js, environment variables prefixed with `NEXT_PUBLIC_` are exposed to the browser.

## Token Management with Next.js

### Server-Side Token Retrieval (Recommended)

```typescript
// app/api/auth/token/route.ts (App Router)
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  const cookieStore = cookies();
  const token = cookieStore.get('access_token')?.value;

  return NextResponse.json({ token });
}
```

### Client-Side Token Access

```typescript
// app/hooks/useToken.ts
'use client';

import { useEffect, useState } from 'react';

export function useToken() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Get from localStorage
    const storedToken = localStorage.getItem('access_token');
    setToken(storedToken);

    // Or fetch from API if using httpOnly cookies
    // fetch('/api/auth/token')
    //   .then(res => res.json())
    //   .then(data => setToken(data.token));
  }, []);

  return token;
}
```

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
```

## Best Practices for Next.js

### 1. Client Components Only

WebSocket connections must be in Client Components (`'use client'`). Server Components cannot use WebSockets.

### 2. Dynamic Imports for WebSocket

```typescript
// Lazy load socket.io-client only on client
import dynamic from 'next/dynamic';

const WebSocketComponent = dynamic(() => import('./WebSocketComponent'), {
  ssr: false,
});
```

### 3. Environment Variables

Always use `NEXT_PUBLIC_` prefix for client-side environment variables:

```typescript
const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:9000/ws/v1/session/';
```

### 4. Token Refresh Handling

```typescript
// app/hooks/useTokenRefresh.ts
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function useTokenRefresh() {
  const router = useRouter();

  useEffect(() => {
    const handleAuthError = async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          router.push('/login');
        }

        const data = await response.json();
        if (data.access_token) {
          localStorage.setItem('access_token', data.access_token);
          // Trigger WebSocket reconnection
          window.dispatchEvent(new Event('token-refreshed'));
        }
      } catch (error) {
        router.push('/login');
      }
    };

    window.addEventListener('token-refreshed', handleAuthError);
    return () => window.removeEventListener('token-refreshed', handleAuthError);
  }, [router]);
}
```

## Quick Start Checklist

- [ ] Install `socket.io-client` in your Next.js project
- [ ] Create `.env.local` with `NEXT_PUBLIC_WS_URL`
- [ ] Create `useWebSocket` hook in `app/hooks/` or `hooks/`
- [ ] Set up `WebSocketProvider` in your root layout or `_app.tsx`
- [ ] Implement token retrieval (localStorage or API)
- [ ] Use `'use client'` directive for components using WebSocket
- [ ] Handle `authenticated` and `error` events
- [ ] Subscribe to `sales:count:update` and `participant:count:update`
- [ ] Test in development
- [ ] Use HTTPS/WSS in production

---

## Additional Resources

- [Socket.IO Client Documentation](https://socket.io/docs/v4/client-api/)
- [Full Implementation Guide](./FRONTEND_WEBSOCKET_IMPLEMENTATION.md)
- [Next.js Client Components](https://nextjs.org/docs/app/building-your-application/rendering/client-components)
- [Next.js Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)

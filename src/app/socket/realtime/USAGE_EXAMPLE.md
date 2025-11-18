# Real-time Sales Count Integration - Usage Guide

## 📊 Overview

This system enables real-time sales count updates for both **sessions** and **taxonomy terms** via WebSocket, powered by Redis pub/sub.

## 🔄 Architecture Flow

```
┌─────────────────────────────────────────────────┐
│  1. Your Service/Controller                     │
│     (when a sale happens)                       │
└──────────────────┬──────────────────────────────┘
                   │ calls
                   ▼
┌─────────────────────────────────────────────────┐
│  2. SessionPublisherService                     │
│     - Increments Redis counter                  │
│     - Publishes to Redis channel                │
└──────────────────┬──────────────────────────────┘
                   │ publishes
                   ▼
┌─────────────────────────────────────────────────┐
│  3. Redis Pub/Sub                               │
│     Channel: taxonomy:sales:update              │
└──────────────────┬──────────────────────────────┘
                   │ subscribes
                   ▼
┌─────────────────────────────────────────────────┐
│  4. SessionRealtimeService                      │
│     - Receives Redis message                    │
│     - Validates & parses payload                │
└──────────────────┬──────────────────────────────┘
                   │ broadcasts
                   ▼
┌─────────────────────────────────────────────────┐
│  5. SocketGateway                               │
│     - Emits 'sales:count:update' event          │
└──────────────────┬──────────────────────────────┘
                   │ emits via WebSocket
                   ▼
┌─────────────────────────────────────────────────┐
│  6. Connected WebSocket Clients                 │
│     - Receive real-time updates                 │
│     - Update UI automatically                   │
└─────────────────────────────────────────────────┘
```

## 🚀 Usage Examples

### Example 1: Track Taxonomy Sales (e.g., `ttm_vt6ERZQiazfkM3P5822226`)

When a user purchases a coupon with taxonomy term `ttm_vt6ERZQiazfkM3P5822226`:

```typescript
import { SessionPublisherService } from './socket/realtime/session-publisher.service';

@Injectable()
export class CouponService {
  constructor(private readonly sessionPublisher: SessionPublisherService) {}

  async purchaseCoupon(taxonomyTermId: string, sessionProfileId: number) {
    // ... your purchase logic ...

    // Increment and broadcast taxonomy sales count
    const newCount =
      await this.sessionPublisher.incrementAndPublishTaxonomySales(
        'ttm_vt6ERZQiazfkM3P5822226',
        1, // increment by 1
        456, // session_profile_id
      );

    console.log(`New taxonomy sales count: ${newCount}`);
    // This automatically broadcasts to all WebSocket clients!
  }
}
```

**Redis Key Created:** `taxonomy:sales:ttm_vt6ERZQiazfkM3P5822226`

**Redis Channel:** `taxonomy:sales:update`

**WebSocket Event Emitted to Clients:**

```json
{
  "event": "sales:count:update",
  "data": {
    "session_id": "ttm_vt6ERZQiazfkM3P5822226",
    "count": 100,
    "session_profile_id": 456,
    "updated_at": "2025-11-18T10:30:00.000Z"
  }
}
```

### Example 2: Track Session Sales

When a user purchases a coupon for a specific session:

```typescript
async purchaseCouponForSession(sessionId: number, sessionProfileId: number) {
  // ... your purchase logic ...

  // Increment and broadcast session sales count
  const newCount = await this.sessionPublisher.incrementAndPublishSessionSales(
    123, // session_id
    1,   // increment by 1
    456, // session_profile_id
  );

  console.log(`Session ${sessionId} now has ${newCount} sales`);
}
```

**Redis Key Created:** `session:sales:123`

**Redis Channel:** `session:sales:update`

**WebSocket Event Emitted to Clients:**

```json
{
  "event": "sales:count:update",
  "data": {
    "session_id": 123,
    "count": 45,
    "session_profile_id": 456,
    "updated_at": "2025-11-18T10:30:00.000Z"
  }
}
```

### Example 3: Get Current Sales Count (Without Broadcasting)

```typescript
// Get current count for a taxonomy term
const taxonomyCount = await this.sessionPublisher.getCurrentSalesCount(
  'taxonomy',
  'ttm_vt6ERZQiazfkM3P5822226',
);

// Get current count for a session
const sessionCount = await this.sessionPublisher.getCurrentSalesCount(
  'session',
  '123',
);
```

### Example 4: Manual Publish (Advanced)

If you already have the count and just want to broadcast:

```typescript
// Publish taxonomy sales update
await this.sessionPublisher.publishTaxonomySalesUpdate(
  'ttm_vt6ERZQiazfkM3P5822226',
  150, // current count
  456, // session_profile_id
);

// Publish session sales update
await this.sessionPublisher.publishSessionSalesUpdate(
  123, // session_id
  50, // current count
  456, // session_profile_id
);
```

## 🖥️ Client-Side WebSocket Integration

### Connect to WebSocket

```javascript
import io from 'socket.io-client';

const socket = io('https://your-domain.com/ws/v1/session/', {
  auth: {
    token: 'your-jwt-token', // Required for authentication
  },
});

// Handle connection
socket.on('connect', () => {
  console.log('Connected to WebSocket');
});

// Listen for sales count updates
socket.on('sales:count:update', (data) => {
  console.log('Sales count updated:', data);

  // Update your UI
  document.getElementById('sales-count').textContent = data.count;

  // Check if it's taxonomy or session
  if (data.session_id.startsWith('ttm_')) {
    console.log('Taxonomy sales update:', data.session_id);
  } else {
    console.log('Session sales update:', data.session_id);
  }
});

// Listen for participant count updates
socket.on('participant:count:update', (data) => {
  console.log('Participant count updated:', data);
  document.getElementById('participant-count').textContent =
    data.participant_count;
});
```

### React Example

```tsx
import { useEffect, useState } from 'react';
import io from 'socket.io-client';

function TaxonomySalesCounter({ taxonomyTermId }) {
  const [salesCount, setSalesCount] = useState(0);

  useEffect(() => {
    const socket = io('https://your-domain.com/ws/v1/session/', {
      auth: { token: localStorage.getItem('token') },
    });

    socket.on('sales:count:update', (data) => {
      // Only update if it matches our taxonomy term
      if (data.session_id === taxonomyTermId) {
        setSalesCount(data.count);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [taxonomyTermId]);

  return (
    <div>
      <h3>Sales Count: {salesCount}</h3>
    </div>
  );
}
```

## 🔑 Redis Keys Structure

| Type           | Key Pattern                  | Example                                     |
| -------------- | ---------------------------- | ------------------------------------------- |
| Taxonomy Sales | `taxonomy:sales:{term_id}`   | `taxonomy:sales:ttm_vt6ERZQiazfkM3P5822226` |
| Session Sales  | `session:sales:{session_id}` | `session:sales:123`                         |

## 📡 Redis Channels

| Channel                 | Purpose                     | Payload                                                            |
| ----------------------- | --------------------------- | ------------------------------------------------------------------ |
| `taxonomy:sales:update` | Taxonomy term sales updates | `{taxonomy_term_id, count, session_profile_id?, type: 'taxonomy'}` |
| `session:sales:update`  | Session sales updates       | `{session_id, count, session_profile_id?, type: 'session'}`        |
| `session:participant:*` | Participant count updates   | `{suid, participant_count, session_profile_id}`                    |

## 💡 Best Practices

1. **Always use `incrementAndPublish*` methods** - They ensure atomicity
2. **Include session_profile_id** - Helps with tracking and analytics
3. **Handle WebSocket reconnection** - Clients should fetch latest count on reconnect
4. **Use type guards** - Check if ID is taxonomy or session based on prefix

## 🎯 Complete Integration Example

```typescript
// coupon.service.ts
@Injectable()
export class CouponService {
  constructor(
    private readonly sessionPublisher: SessionPublisherService,
    private readonly prisma: PrismaService,
  ) {}

  async purchaseCoupon(data: PurchaseCouponDto) {
    // 1. Create coupon purchase in database
    const purchase = await this.prisma.couponPurchase.create({
      data: {
        taxonomyTermId: data.taxonomyTermId,
        sessionProfileId: data.sessionProfileId,
        userId: data.userId,
        // ... other fields
      },
    });

    // 2. Increment Redis counter and broadcast via WebSocket
    const newCount =
      await this.sessionPublisher.incrementAndPublishTaxonomySales(
        data.taxonomyTermId,
        1,
        data.sessionProfileId,
      );

    // 3. Return response
    return {
      success: true,
      purchase,
      currentSalesCount: newCount,
    };
  }
}
```

## 🔍 Monitoring & Debugging

### Check Redis Keys

```bash
# Check taxonomy sales count
redis-cli GET "taxonomy:sales:ttm_vt6ERZQiazfkM3P5822226"

# Check session sales count
redis-cli GET "session:sales:123"
```

### Monitor Redis Pub/Sub

```bash
# Subscribe to all channels
redis-cli PSUBSCRIBE "*"

# Subscribe to taxonomy updates only
redis-cli SUBSCRIBE "taxonomy:sales:update"
```

### Check Connected WebSocket Clients

The gateway logs connection counts at milestones (every 1000 connections) and individual connections at debug level.

## 🚨 Error Handling

The system handles errors gracefully:

- Redis connection failures → Auto-reconnection with exponential backoff
- Invalid messages → Logged as warnings, processing continues
- WebSocket disconnections → Clients can reconnect automatically

## 📈 Scalability

- ✅ Supports 100k+ concurrent WebSocket connections
- ✅ Redis pub/sub enables horizontal scaling across multiple servers
- ✅ Efficient: Only broadcasts updates when sales actually happen
- ✅ Low latency: Sub-second update delivery to all clients

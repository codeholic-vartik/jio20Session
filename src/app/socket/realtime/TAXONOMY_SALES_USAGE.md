# Join Taxonomy Sales Channel - Usage Guide

## 🎯 Overview

When you join a taxonomy term's sales channel (e.g., `ttm_vt6ERZQiazfkM3P5822226`), you will receive:

1. ✅ **Current Sales Count** - Real-time count from Redis
2. ✅ **Taxonomy Term Info** - Name, slug, description, etc.
3. ✅ **Session Profiles** - All profiles linked to this taxonomy term
4. ✅ **Current/Upcoming Sessions** - All active sessions for those profiles
5. ✅ **Real-time Updates** - Live sales count updates as they happen

## 🚀 Client-Side Usage

### Step 1: Connect to WebSocket

```javascript
import io from 'socket.io-client';

const socket = io('https://your-domain.com/ws/v1/session/', {
  auth: {
    token: 'your-jwt-token', // Required for authentication
  },
});

socket.on('connect', () => {
  console.log('Connected to WebSocket');
});
```

### Step 2: Join Taxonomy Sales Channel

```javascript
// Join the taxonomy term's sales channel
socket.emit('join:taxonomy:sales', {
  taxonomy_term_id: 'ttm_vt6ERZQiazfkM3P5822226',
});
```

### Step 3: Receive Initial Data

When you join, you'll immediately receive all the data:

```javascript
socket.on('taxonomy:sales:joined', (data) => {
  console.log('Taxonomy Term:', data.taxonomy_term);
  // {
  //   id: 123,
  //   tmuid: "ttm_vt6ERZQiazfkM3P5822226",
  //   name: "Premium Category",
  //   slug: "premium-category",
  //   description: "Premium products",
  //   is_active: true
  // }

  console.log('Current Sales Count:', data.sales_count);
  // 150

  console.log('Session Profiles:', data.session_profiles);
  // [
  //   {
  //     id: 456,
  //     spuid: "sp_abc123",
  //     title: "Premium Session Profile",
  //     description: "...",
  //     max_slots: 1000,
  //     max_sessions: 5,
  //     sales_trigger_count: 200,
  //     is_active: true
  //   }
  // ]

  console.log('Sessions:', data.sessions);
  // [
  //   {
  //     id: 789,
  //     suid: "sess_xyz789",
  //     session_profile_id: 456,
  //     name: "Upcoming Premium Session",
  //     start_time: "2025-11-20T10:00:00Z",
  //     end_time: "2025-11-20T12:00:00Z",
  //     status: "UPCOMING",
  //     current_sales_count: 45,
  //     current_participant_count: 120
  //   }
  // ]

  console.log('Joined At:', data.joined_at);
  // "2025-11-18T10:30:00.000Z"
});
```

### Step 4: Receive Real-time Updates

As sales happen, you'll receive updates automatically:

```javascript
socket.on('sales:count:update', (data) => {
  // Check if this update is for your taxonomy term
  if (data.session_id === 'ttm_vt6ERZQiazfkM3P5822226') {
    console.log('Sales count updated!', data);
    // {
    //   session_id: "ttm_vt6ERZQiazfkM3P5822226",
    //   count: 151,  // New count
    //   session_profile_id: 456,
    //   updated_at: "2025-11-18T10:31:00.000Z"
    // }

    // Update your UI
    document.getElementById('sales-count').textContent = data.count;
  }
});
```

## 📱 Complete React Example

```tsx
import { useEffect, useState } from 'react';
import io from 'socket.io-client';

interface TaxonomySalesData {
  taxonomy_term: {
    id: number;
    tmuid: string;
    name: string;
    slug: string;
    description: string | null;
    is_active: boolean | null;
  };
  sales_count: number;
  session_profiles: Array<{
    id: number;
    spuid: string;
    title: string;
    description: string | null;
    max_slots: number;
    max_sessions: number | null;
    sales_trigger_count: number | null;
    is_active: boolean;
  }>;
  sessions: Array<{
    id: number;
    suid: string;
    session_profile_id: number;
    name: string | null;
    start_time: string | null;
    end_time: string | null;
    status: string;
    current_sales_count: number;
    current_participant_count: number;
  }>;
  joined_at: string;
}

function TaxonomySalesDashboard({
  taxonomyTermId,
}: {
  taxonomyTermId: string;
}) {
  const [data, setData] = useState<TaxonomySalesData | null>(null);
  const [salesCount, setSalesCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = io('https://your-domain.com/ws/v1/session/', {
      auth: { token: localStorage.getItem('token') },
    });

    socket.on('connect', () => {
      // Join the taxonomy sales channel
      socket.emit('join:taxonomy:sales', {
        taxonomy_term_id: taxonomyTermId,
      });
    });

    // Receive initial data
    socket.on('taxonomy:sales:joined', (joinedData: TaxonomySalesData) => {
      setData(joinedData);
      setSalesCount(joinedData.sales_count);
    });

    // Receive real-time updates
    socket.on('sales:count:update', (update) => {
      if (update.session_id === taxonomyTermId) {
        setSalesCount(update.count);
      }
    });

    // Handle errors
    socket.on('error', (err) => {
      setError(err.message);
      console.error('WebSocket error:', err);
    });

    return () => {
      socket.disconnect();
    };
  }, [taxonomyTermId]);

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  if (!data) {
    return <div>Loading...</div>;
  }

  return (
    <div className="taxonomy-sales-dashboard">
      <h2>{data.taxonomy_term.name}</h2>
      <p>{data.taxonomy_term.description}</p>

      <div className="sales-count">
        <h3>Current Sales Count</h3>
        <div className="count-display">{salesCount}</div>
      </div>

      <div className="session-profiles">
        <h3>Session Profiles ({data.session_profiles.length})</h3>
        {data.session_profiles.map((profile) => (
          <div key={profile.id} className="profile-card">
            <h4>{profile.title}</h4>
            <p>Max Slots: {profile.max_slots}</p>
            <p>Max Sessions: {profile.max_sessions || 'Unlimited'}</p>
            <p>Sales Trigger: {profile.sales_trigger_count || 'N/A'}</p>
          </div>
        ))}
      </div>

      <div className="sessions">
        <h3>Current/Upcoming Sessions ({data.sessions.length})</h3>
        {data.sessions.map((session) => (
          <div key={session.id} className="session-card">
            <h4>{session.name || session.suid}</h4>
            <p>Status: {session.status}</p>
            <p>Sales: {session.current_sales_count}</p>
            <p>Participants: {session.current_participant_count}</p>
            {session.start_time && (
              <p>Starts: {new Date(session.start_time).toLocaleString()}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default TaxonomySalesDashboard;
```

## 🔄 How It Works

1. **Client sends** `join:taxonomy:sales` with `taxonomy_term_id`
2. **Server joins** client to room: `taxonomy:sales:ttm_vt6ERZQiazfkM3P5822226`
3. **Server fetches**:
   - Taxonomy term from database
   - Current sales count from Redis
   - Session profiles linked to term
   - Current/upcoming sessions
4. **Server sends** all data via `taxonomy:sales:joined` event
5. **When sales happen**, server broadcasts to room via `sales:count:update`

## 📡 Room Structure

- **Room Name**: `taxonomy:sales:{taxonomy_term_id}`
- **Example**: `taxonomy:sales:ttm_vt6ERZQiazfkM3P5822226`
- **Updates**: All clients in this room receive real-time sales count updates

## ✅ Benefits

- ✅ **Instant Data** - Get all info immediately when joining
- ✅ **Real-time Updates** - Automatic updates as sales happen
- ✅ **Efficient** - Only clients in the room receive updates
- ✅ **Complete Context** - Term, profiles, sessions, and counts all together
- ✅ **Scalable** - Works with 100k+ concurrent connections

## 🚨 Error Handling

```javascript
socket.on('error', (error) => {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      // Redirect to login
      break;
    case 'TAXONOMY_NOT_FOUND':
      // Show "Term not found" message
      break;
    case 'INVALID_REQUEST':
      // Show validation error
      break;
    case 'JOIN_ERROR':
      // Show generic error, retry connection
      break;
  }
});
```

## 🎯 Example Flow

```
1. User opens page for taxonomy term "ttm_vt6ERZQiazfkM3P5822226"
2. Client connects to WebSocket
3. Client emits: join:taxonomy:sales { taxonomy_term_id: "ttm_vt6ERZQiazfkM3P5822226" }
4. Server responds with:
   - Taxonomy term info
   - Current sales count: 150
   - 2 session profiles
   - 3 upcoming sessions
5. User sees dashboard with all data
6. When a sale happens:
   - Server publishes to Redis
   - SessionRealtimeService picks it up
   - SocketGateway broadcasts to room
   - Client receives update: count: 151
   - UI updates automatically! ✨
```

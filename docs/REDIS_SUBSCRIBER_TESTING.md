# Redis Subscriber Testing Guide

This guide explains how to test the Redis pub/sub subscriber that listens for `session:sales:threshold_reached` events.

## What You'll See in Your NestJS App Logs

When your NestJS app starts, you should see:

```
[RedisSubscriberService] 🎧 Subscribed to Redis channel: session:sales:threshold_reached
[RedisSubscriberService] ✅ Redis pub/sub subscriber initialized successfully - Listening for events...
```

When a message is published to the channel, you'll see:

```
[RedisSubscriberService] ✅ RECEIVED threshold reached event: session_id=456, product_id=123
[RedisSubscriberService] 📤 QUEUED threshold-reached job: session_id=456, product_id=123
🔔 WORKER: Processing threshold reached - session_id=456, product_id=123
```

## Quick Test (3 Steps)

### Step 1: Start Your NestJS App

```bash
npm run start:dev
```

Wait for the initialization logs to appear.

### Step 2: Publish a Test Message

Open a **new terminal** and use one of these methods:

#### Method A: Using redis-cli (Easiest)

```bash
redis-cli PUBLISH session:sales:threshold_reached '{"product_id":"prod_123","session_id":"sess_456"}'
```

#### Method B: Using Node.js One-Liner

```bash
node -e "const r=require('ioredis');const c=new r('redis://localhost:6379');c.publish('session:sales:threshold_reached','{\"product_id\":\"prod_123\",\"session_id\":\"sess_456\"}').then(n=>{console.log('✅ Published to',n,'subscriber(s)');process.exit()})"
```

#### Method C: Using Node.js Script

Create `test-publish.js`:

```javascript
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis
  .publish(
    'session:sales:threshold_reached',
    JSON.stringify({
      product_id: 'prod_123',
      session_id: 'sess_456',
    }),
  )
  .then((n) => {
    console.log('✅ Published to', n, 'subscriber(s)');
    process.exit(0);
  });
```

Run: `node test-publish.js`

#### Method D: Using Python (if you have redis-py)

```python
import redis
import json

r = redis.Redis.from_url('redis://localhost:6379')

payload = {
    "product_id": "prod_123",
    "session_id": "sess_456"
}

r.publish('session:sales:threshold_reached', json.dumps(payload))
print("✅ Message published!")
```

### Step 3: Check Your NestJS App Terminal

You should immediately see the logs showing the event was received and processed!

## Expected Log Flow

### 1. On App Start

```
[RedisSubscriberService] 🎧 Subscribed to Redis channel: session:sales:threshold_reached
[RedisSubscriberService] ✅ Redis pub/sub subscriber initialized successfully - Listening for events...
```

### 2. When Message Received

```
[RedisSubscriberService] ✅ RECEIVED threshold reached event: session_id=456, product_id=123
[RedisSubscriberService] 📤 QUEUED threshold-reached job: session_id=456, product_id=123
```

### 3. When Job Processed

```
🔔 WORKER: Processing threshold reached - session_id=456, product_id=123
```

## Message Format

The subscriber expects messages in this JSON format:

```json
{
  "product_id": "prod_123",
  "session_id": "sess_456"
}
```

- `product_id` must start with `prod_` prefix
- `session_id` must start with `sess_` prefix
- The numeric IDs will be extracted (e.g., `prod_123` → `123`)

## Troubleshooting

### No logs appearing?

1. **Check Redis is running:**

   ```bash
   redis-cli ping
   ```

   Should return `PONG`

2. **Check Redis connection:**

   - Verify `REDIS_URL` environment variable is set correctly
   - Default: `redis://localhost:6379`

3. **Check NestJS app is running:**

   - Make sure you see the initialization logs
   - If not, check for errors in the terminal

4. **Check subscriber count:**
   - When publishing, redis-cli returns the number of subscribers
   - Should be `1` if your NestJS app is subscribed
   - If `0`, the app hasn't subscribed (check for errors)

### Connection errors?

- Verify Redis URL format: `redis://host:port` or `rediss://host:port` for TLS
- Check network connectivity to Redis server
- Verify Redis server is accepting connections

### Invalid payload warnings?

If you see warnings about invalid payload format:

- Ensure JSON is valid
- Check `product_id` starts with `prod_`
- Check `session_id` starts with `sess_`
- Verify message is a valid JSON string

## Integration with Python Service

When your Python FastAPI service publishes using:

```python
redis_ops.publish_threshold_reached(session_id=456, product_id=123)
```

The NestJS subscriber will automatically:

1. Receive the message
2. Parse and extract IDs
3. Queue a job in BullMQ
4. Process the job in the worker

All logs will appear in your NestJS app terminal!

# Testing Redis Subscriber - Quick Guide

## What You'll See in Your NestJS App Logs

When a message is published to `session:sales:threshold_reached`, you should see these logs in your terminal:

```
[RedisSubscriberService] Subscribed to Redis channel: session:sales:threshold_reached
[RedisSubscriberService] Redis pub/sub subscriber initialized successfully
[RedisSubscriberService] Received threshold reached event: session_id=456, product_id=123
[RedisSubscriberService] Queued threshold-reached job: session_id=456, product_id=123
```

## Method 1: Using redis-cli (Easiest)

1. **Make sure your NestJS app is running:**

   ```bash
   npm run start:dev
   ```

2. **Open a new terminal and connect to Redis:**

   ```bash
   redis-cli
   ```

3. **Publish a test message:**

   ```bash
   PUBLISH session:sales:threshold_reached '{"product_id":"prod_123","session_id":"sess_456"}'
   ```

4. **Check your NestJS app terminal** - you should see the logs above!

## Method 2: Using Node.js Script

Create a file `test-publish.js`:

```javascript
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const message = JSON.stringify({
  product_id: 'prod_123',
  session_id: 'sess_456',
});

redis
  .publish('session:sales:threshold_reached', message)
  .then((count) => {
    console.log(`Published to ${count} subscriber(s)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
```

Run it:

```bash
node test-publish.js
```

## Method 3: Using Python (if you have redis-py)

```python
import redis
import json

r = redis.Redis.from_url('redis://localhost:6379')

payload = {
    "product_id": "prod_123",
    "session_id": "sess_456"
}

r.publish('session:sales:threshold_reached', json.dumps(payload))
print("Message published!")
```

## Expected Log Flow

1. **On App Start:**

   ```
   [RedisSubscriberService] Subscribed to Redis channel: session:sales:threshold_reached
   [RedisSubscriberService] Redis pub/sub subscriber initialized successfully
   ```

2. **When Message Received:**

   ```
   [RedisSubscriberService] Received threshold reached event: session_id=456, product_id=123
   [RedisSubscriberService] Queued threshold-reached job: session_id=456, product_id=123
   ```

3. **When Job Processed (in worker):**
   ```
   Processing threshold reached: session_id=456, product_id=123
   ```

## Troubleshooting

- **No logs?** Check that Redis is running: `redis-cli ping` should return `PONG`
- **Connection error?** Make sure `REDIS_URL` env variable is set correctly
- **No subscriber count?** Make sure your NestJS app is running and has subscribed

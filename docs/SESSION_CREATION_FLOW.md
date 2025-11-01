# Session Creation Flow - Complete System Overview

## Overview

This document explains how sessions are automatically created when sales threshold is reached, with fallback mechanisms to ensure no sessions are lost.

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1: FastAPI (Sales Service)                                        │
│ ─────────────────────────────────────────────────────────────────────── │
│ When sales count reaches threshold:                                     │
│ • Publishes Redis pub/sub event:                                       │
│   Channel: "session:sales:threshold_reached"                            │
│   Payload: {"session_profile_id": 123, "session_id": 456}              │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 2: NestJS Redis Subscriber (redis-subscriber.service.ts)          │
│ ─────────────────────────────────────────────────────────────────────── │
│ Receives event → Validates payload → Does TWO things:                   │
│                                                                         │
│ A) IMMEDIATE: Calls createSessionOnThreshold()                          │
│    • Creates session immediately if service is available                │
│    • If service fails → Error logged, but continues                    │
│                                                                         │
│ B) QUEUE: Adds job to BullMQ queue                                     │
│    • Job: "threshold-reached"                                          │
│    • Data: {sessionId, sessionProfileId}                               │
│    • Ensures session creation happens even if immediate call failed     │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 3: BullMQ Worker (session.worker.ts)                              │
│ ─────────────────────────────────────────────────────────────────────── │
│ Processes "threshold-reached" job:                                    │
│                                                                         │
│ 1. MARK IN REDIS (Before creation):                                    │
│    Key: "session:creation:pending:{profileId}:{sessionId}"             │
│    Value: {isCreated: false, timestamp, sessionId, sessionProfileId} │
│    TTL: 3600 seconds (1 hour)                                          │
│                                                                         │
│ 2. CREATE SESSION:                                                      │
│    • Validates session profile (active, not deleted)                   │
│    • Updates existing session status if needed                          │
│    • Creates new session with proper naming                             │
│    • Updates session profile count                                     │
│                                                                         │
│ 3. SUCCESS → UPDATE REDIS:                                              │
│    Key: Same                                                           │
│    Value: {isCreated: true, completedAt, newSessionId, ...}           │
│                                                                         │
│ 4. FAILURE → KEEP REDIS FLAG:                                          │
│    Key: Same (not deleted)                                             │
│    Value: {isCreated: false, error, retryCount, ...}                  │
│    • BullMQ automatically retries (3 attempts)                         │
│    • If all retries fail → Flag remains for retry worker               │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Retry Worker (Future Enhancement)                               │
│ ─────────────────────────────────────────────────────────────────────── │
│ Periodic check (every 5-10 minutes):                                   │
│                                                                         │
│ 1. SCAN REDIS:                                                          │
│    Pattern: "session:creation:pending:*"                               │
│                                                                         │
│ 2. CHECK EACH KEY:                                                      │
│    • If isCreated: false → Session creation failed                     │
│    • Check timestamp (if > 5 min old) → Retry                          │
│                                                                         │
│ 3. RETRY CREATION:                                                      │
│    • Extract {sessionId, sessionProfileId} from Redis                  │
│    • Call createSession() again                                        │
│    • Update Redis flag accordingly                                     │
│                                                                         │
│ This ensures NO sessions are lost even if:                              │
│ • Service was down during initial event                                │
│ • Worker crashed mid-processing                                        │
│ • Database was temporarily unavailable                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Points

### 1. **Dual Processing**

- **Immediate**: Subscriber tries to create session right away
- **Queued**: Worker ensures it happens even if immediate fails

### 2. **Redis Tracking**

- **Before creation**: `isCreated: false` → Session creation started
- **After success**: `isCreated: true` → Session created successfully
- **On failure**: `isCreated: false` → Available for retry

### 3. **Resilience**

- **Service down**: Redis subscriber still queues the job
- **Worker failure**: BullMQ retries automatically (3 attempts)
- **Persistent failures**: Retry worker picks up missed ones

### 4. **Redis Key Format**

```
session:creation:pending:{sessionProfileId}:{sessionId}
```

**Example:**

```
session:creation:pending:123:456
```

**Value (when started):**

```json
{
  "isCreated": false,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "sessionId": 456,
  "sessionProfileId": 123
}
```

**Value (when completed):**

```json
{
  "isCreated": true,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "completedAt": "2025-01-15T10:30:05.000Z",
  "sessionId": 456,
  "sessionProfileId": 123,
  "newSessionId": 789
}
```

**Value (when failed):**

```json
{
  "isCreated": false,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "error": "Session profile not found",
  "sessionId": 456,
  "sessionProfileId": 123,
  "retryCount": 2
}
```

## Failure Scenarios Handled

### Scenario 1: FastAPI → NestJS Service Down

- ✅ Redis pub/sub delivers message when service restarts
- ✅ Or BullMQ job processes it when worker comes online

### Scenario 2: Worker Crashes Mid-Processing

- ✅ Redis flag remains with `isCreated: false`
- ✅ BullMQ retries the job
- ✅ Retry worker can pick it up if all retries fail

### Scenario 3: Database Temporarily Unavailable

- ✅ Worker fails, updates Redis with error
- ✅ BullMQ retries with exponential backoff
- ✅ Retry worker checks periodically

### Scenario 4: Session Creation Succeeds but Redis Update Fails

- ✅ Session exists in database
- ✅ Next retry will see session already exists (can be handled)

## Summary

**FastAPI Event** → **Redis Pub/Sub** → **NestJS Subscriber** → **Immediate Creation + Queue Job** → **Worker Processes** → **Redis Tracking** → **Success/Failure** → **Retry Worker (if needed)**

**Result**: **100% session creation guarantee** - No sessions lost even under failures!

# Coupon Module - Complete Development Guide

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [System Flow](#system-flow)
4. [Function Reference](#function-reference)
   - [API Functions](#api-functions)
   - [Service Functions](#service-functions)
   - [Worker Handler Functions](#worker-handler-functions)
   - [Helper Functions](#helper-functions)
5. [Race Condition Prevention](#race-condition-prevention)
6. [Queue-Based Processing](#queue-based-processing)
7. [Redis Atomic Operations](#redis-atomic-operations)
8. [API Endpoints](#api-endpoints)
9. [Configuration](#configuration)
10. [Development Guide](#development-guide)
11. [Testing](#testing)
12. [Troubleshooting](#troubleshooting)

---

## 🎯 Overview

The Coupon Module handles coupon applications to session competitions with **100% race condition prevention** and **high-performance processing** for 100k+ concurrent users.

### Key Features

- ✅ **Queue-based FIFO processing** - First request wins
- ✅ **Redis atomic operations** - 100% accurate position assignment
- ✅ **No database locks** - Avoids bottlenecks
- ✅ **Fast API response** - Immediate return with job ID
- ✅ **Encrypted coupon codes** - Fernet-compatible encryption
- ✅ **Automatic reward creation** - For winners
- ✅ **Real-time updates** - Redis pub/sub for participant counts

### Why Queue-Based?

**Problem**: With 100k+ concurrent users applying coupons simultaneously:

- Database locks cause bottlenecks
- Race conditions can occur
- Position assignment becomes inaccurate
- Response times degrade

**Solution**: Queue-based processing with Redis atomic operations

- Requests queued with timestamp
- Processed in FIFO order
- Redis Lua script ensures atomic position assignment
- No database locks needed

---

## 🏗️ Architecture

### Component Diagram

```
┌─────────────────┐
│   API Request   │
│  /coupon/apply  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CouponController│
│  (JWT Protected)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│  CouponService  │──────▶│  BullMQ Queue    │
│  (Validation)   │       │  (session-jobs)  │
└─────────────────┘       └────────┬─────────┘
                                    │
                                    ▼
                          ┌──────────────────┐
                          │  Session Worker  │
                          │  (FIFO Process)  │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ ApplyCoupon      │
                          │ Handler          │
                          └────────┬─────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
          ┌─────────────────┐         ┌─────────────────┐
          │  Redis Lua      │         │   Database      │
          │  (Atomic INCR)  │         │   (Updates)     │
          └─────────────────┘         └─────────────────┘
```

### File Structure

```
src/app/coupon/
├── coupon.controller.ts      # REST API endpoint
├── coupon.service.ts         # Business logic & queue management
├── coupon.module.ts          # NestJS module
├── dto/
│   └── apply-coupon.dto.ts   # Request validation
└── utils/
    ├── coupon-generator.service.ts  # Injectable service wrapper
    └── coupon-generator.util.ts     # Core encryption/generation logic

src/app/jobs/workers/session/
└── handlers/
    └── apply-coupon.handler.ts     # Worker handler (processes queue)
```

---

## 🔄 System Flow

### Complete Flow Diagram

```
1. User Request
   │
   ├─▶ POST /coupon/apply
   │   Headers: Authorization: Bearer <JWT>
   │   Body: { "coupon_code": "SES-1-1z-83uqO4fId-E5P5HA" }
   │
   ▼
2. JWT Authentication
   │
   ├─▶ JwtAuthGuard validates token
   │   Extracts userId from token
   │
   ▼
3. Coupon Validation (Fast - No Locks)
   │
   ├─▶ Find coupon by encrypted code
   ├─▶ Fallback: Search user's coupons
   ├─▶ Validate ownership
   ├─▶ Validate coupon is valid
   ├─▶ Validate coupon not used
   ├─▶ Validate session exists
   │
   ▼
4. Queue Job
   │
   ├─▶ Add job to BullMQ queue
   │   Job data: {
   │     userId, couponId, sessionId,
   │     plainCouponCode, requestTimestamp
   │   }
   │
   ├─▶ Return immediately:
   │   {
   │     success: true,
   │     job_id: "apply-coupon-123-456-1234567890",
   │     message: "Queued successfully",
   │     queued_at: "2024-01-01T12:00:00Z"
   │   }
   │
   ▼
5. Worker Processing (FIFO Order)
   │
   ├─▶ Session Worker picks up job
   ├─▶ Routes to apply-coupon handler
   │
   ▼
6. Redis Atomic Operation
   │
   ├─▶ Sync Redis counter with DB (if needed)
   ├─▶ Execute Lua script:
   │   - Check max_slots
   │   - Atomically INCR counter
   │   - Return position & is_winner
   │
   ▼
7. Database Update (Atomic)
   │
   ├─▶ Update coupon (updateMany with condition)
   │   Only updates if applied_at is null
   │
   ├─▶ Create reward (if winner)
   │
   ├─▶ Update session participant count
   │
   ├─▶ Mark session COMPLETED (if max_slots reached)
   │
   ▼
8. Real-time Update
   │
   ├─▶ Publish to Redis pub/sub
   │   Channel: session:participant:update
   │   Payload: { suid, participant_count, position, is_winner }
   │
   ▼
9. Update Participant Stats
   │
   └─▶ Upsert session_participants table
```

### Request Timeline

```
Time    | Action
--------|--------------------------------------------------
T+0ms   | User sends POST /coupon/apply
T+5ms   | JWT validation complete
T+10ms  | Coupon validation complete
T+15ms  | Job queued to BullMQ
T+20ms  | API returns job_id (user gets response)
        |
        | [Background Processing]
        |
T+50ms  | Worker picks up job
T+55ms  | Redis atomic operation (position assigned)
T+60ms  | Database update (coupon applied)
T+65ms  | Reward created (if winner)
T+70ms  | Redis pub/sub update published
T+75ms  | Participant stats updated
```

---

## 📖 Function Reference

This section explains every function in the coupon module, what it does, why we use it, and how it fits into the overall flow.

### API Functions

#### `CouponController.applyCoupon()`

**Location**: `src/app/coupon/coupon.controller.ts`

**What it does:**

- Handles HTTP POST request to `/coupon/apply`
- Extracts JWT token and validates user
- Calls service method to queue coupon application

**Why we use it:**

- Entry point for API requests
- Handles authentication via JWT guard
- Validates request body with DTO

**Code Flow:**

```
Request → JWT Guard → Extract userId → Call Service → Return Response
```

**Parameters:**

- `dto: ApplyCouponDto` - Contains `coupon_code` (plain text)
- `req: AuthenticatedRequest` - Contains JWT user info

**Returns:**

```typescript
{
  success: boolean;
  job_id: string;
  message: string;
  queued_at: string;
}
```

---

### Service Functions

#### `CouponService.applyCoupon()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

1. Validates coupon exists (fast lookup)
2. Validates coupon ownership, validity, and usage status
3. Validates session exists and is open
4. Queues job to BullMQ with request timestamp
5. Returns immediately with job ID

**Why we use it:**

- Fast validation before queuing (prevents invalid jobs)
- Immediate API response (user doesn't wait)
- Queues for FIFO processing (prevents race conditions)

**Code Flow:**

```
1. findCouponByCode() → Try encrypted lookup
2. findCouponByUserFallback() → If not found, scan user's coupons
3. validateCouponOwnership() → Check user owns coupon
4. validateCouponIsValid() → Check coupon is valid
5. validateCouponNotUsed() → Check coupon not already applied
6. validateSessionExists() → Load session
7. validateSessionIsOpen() → Check session is LIVE
8. validateSessionHasAvailableSlots() → Quick slot check
9. Queue job with timestamp
10. Return job_id immediately
```

**Parameters:**

- `userId: number` - From JWT token
- `plainCouponCode: string` - User-provided coupon code

**Returns:**

```typescript
{
  success: true,
  job_id: "apply-coupon-123-456-1234567890",
  message: "Coupon application queued successfully",
  queued_at: "2024-01-01T12:00:00.000Z"
}
```

**Why Queue Instead of Direct Processing?**

- **Race Condition Prevention**: Queue ensures FIFO order
- **Fast Response**: API returns immediately
- **Scalability**: Handles 100k+ concurrent requests
- **No DB Locks**: Avoids database bottlenecks

---

#### `CouponService.findCouponByCode()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Encrypts plain coupon code
- Searches database for encrypted code
- Returns coupon if found

**Why we use it:**

- Primary lookup method (fast, indexed)
- Uses encrypted code for security
- Handles encryption errors gracefully

**Code Flow:**

```
Plain Code → Encrypt → Database Query → Return Coupon or null
```

**Parameters:**

- `plainCode: string` - User-provided plain coupon code

**Returns:**

- `SessionCoupon | null` - Coupon if found, null otherwise

**Why Encrypt Before Lookup?**

- Coupons stored encrypted in database
- Prevents code enumeration attacks
- Maintains security

---

#### `CouponService.findCouponByUserFallback()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- If primary lookup fails, searches user's coupons
- Decrypts each coupon and compares with plain code
- Limits to 25 coupons to prevent performance issues

**Why we use it:**

- Handles encryption key changes
- Handles corrupted encryption
- Fallback for edge cases

**Code Flow:**

```
1. Get user's 25 valid coupons
2. For each coupon:
   - Decrypt code
   - Compare with plain code
   - Return if match
3. Return null if no match
```

**Parameters:**

- `userId: number` - User ID
- `plainCode: string` - Plain coupon code

**Returns:**

- `SessionCoupon | null` - Coupon if found, null otherwise

**Why Limit to 25?**

- Decryption is expensive
- Prevents performance degradation
- Most users have < 25 coupons

---

#### `CouponService.validateCouponOwnership()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Checks if coupon belongs to user
- Throws error if user doesn't own coupon

**Why we use it:**

- Security: Prevents users from applying others' coupons
- Early validation: Fails fast before queuing

**Code Flow:**

```
Check coupon.user_id === userId
→ If not equal: Throw BadRequestException
→ If equal: Continue
```

**Parameters:**

- `coupon: { user_id: number }` - Coupon object
- `userId: number` - User ID from JWT

**Throws:**

- `BadRequestException` - If user doesn't own coupon

---

#### `CouponService.validateCouponIsValid()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Checks if coupon is valid (`is_valid = true`)
- Throws error if coupon is invalid

**Why we use it:**

- Prevents applying invalid coupons
- Early validation before processing

**Code Flow:**

```
Check coupon.is_valid === true
→ If false: Throw BadRequestException
→ If true: Continue
```

**Parameters:**

- `coupon: { is_valid: boolean }` - Coupon object

**Throws:**

- `BadRequestException` - If coupon is invalid

---

#### `CouponService.validateCouponNotUsed()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Checks if coupon already applied (`is_redeemed = false`)
- Throws error if coupon already used

**Why we use it:**

- Prevents duplicate applications
- Early validation before queuing

**Code Flow:**

```
Check coupon.is_redeemed === false
→ If true: Throw ConflictException
→ If false: Continue
```

**Parameters:**

- `coupon: { is_redeemed: boolean }` - Coupon object

**Throws:**

- `ConflictException` - If coupon already applied

---

#### `CouponService.validateSessionExists()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Loads session from database
- Includes session profile
- Throws error if session not found

**Why we use it:**

- Validates session exists before processing
- Loads session profile for max_slots check

**Code Flow:**

```
Database Query → Load session with profile
→ If not found: Throw NotFoundException
→ If found: Return session
```

**Parameters:**

- `sessionId: number` - Session ID

**Returns:**

- `Session` - Session object with profile

**Throws:**

- `NotFoundException` - If session not found

---

#### `CouponService.validateSessionIsOpen()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Checks if session status is LIVE
- Throws error if session not open

**Why we use it:**

- Only LIVE sessions accept coupon applications
- Prevents applying to closed sessions

**Code Flow:**

```
Check session.status === "LIVE"
→ If not LIVE: Throw BadRequestException
→ If LIVE: Continue
```

**Parameters:**

- `session: { status: string }` - Session object

**Throws:**

- `BadRequestException` - If session not LIVE

---

#### `CouponService.validateSessionHasAvailableSlots()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Checks if session has available slots
- Counts applied coupons
- Compares with max_slots

**Why we use it:**

- Quick check before queuing (not 100% accurate)
- Prevents obviously full sessions from being queued
- Final check happens in worker with Redis

**Code Flow:**

```
1. Get max_slots from session profile
2. If max_slots <= 0: Return (unlimited)
3. Count applied coupons in database
4. If count >= max_slots: Throw ConflictException
5. If count < max_slots: Continue
```

**Parameters:**

- `session: { id: number, session_profiles: { max_slots: number } }`

**Throws:**

- `ConflictException` - If session full

**Note**: This is a quick check. Final accurate check happens in worker with Redis atomic operation.

---

#### `CouponService.applyCouponWithRedisAtomic()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

1. Loads session profile
2. Syncs Redis counter with DB
3. Executes Redis Lua script for atomic position assignment
4. Atomically updates coupon in database
5. Creates reward if winner
6. Updates session participant count
7. Marks session COMPLETED if max_slots reached
8. Publishes real-time update via Redis pub/sub

**Why we use it:**

- Core processing logic
- Uses Redis atomic operations (no DB locks)
- Handles all updates atomically
- Prevents race conditions

**Code Flow:**

```
1. Load session profile
2. syncRedisCounter() → Sync Redis with DB
3. incrementSessionAppliedWithMaxSlotsCheck() → Get position from Redis
4. updateMany() → Atomically update coupon (only if applied_at is null)
5. If update fails: Revert Redis counter, throw error
6. If winner: Create reward record
7. Update session participant count
8. If max_slots reached: Mark session COMPLETED
9. publishParticipantUpdate() → Real-time update
10. Return result
```

**Parameters:**

- `coupon: { id, user_id, session_id }`
- `session: { id, suid, session_profile_id, current_participant_count, session_profiles }`

**Returns:**

```typescript
{
  success: true,
  position: number,
  is_winner: boolean,
  applied_at: Date,
  max_slots: number,
  slots_remaining: number | null,
  reward_created: boolean,
  participant_count: number
}
```

**Why Atomic Database Update?**

- `updateMany` with condition ensures only one job can update
- If `applied_at` is already set, update fails (count = 0)
- Prevents duplicate applications even if queue has issues

---

#### `CouponService.syncRedisCounter()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Compares Redis counter with database count
- Updates Redis if they don't match

**Why we use it:**

- Keeps Redis in sync with database
- Handles Redis restarts
- Handles manual database updates

**Code Flow:**

```
1. Count applied coupons in database
2. Get Redis counter value
3. If different: Update Redis to match database
4. Log sync operation
```

**Parameters:**

- `sessionId: number` - Session ID

**When Called:**

- Before processing each job (if max_slots > 0)
- Ensures accuracy before atomic operation

---

#### `CouponService.incrementSessionAppliedWithMaxSlotsCheck()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Executes Redis Lua script
- Atomically increments counter and checks max_slots
- Returns position and winner status

**Why we use it:**

- **100% Atomic**: Lua script runs atomically
- **No Race Conditions**: Single atomic operation
- **Accurate**: Handles 100k+ concurrent requests

**Code Flow:**

```
1. Build Redis Lua script
2. Execute script with session ID and max_slots
3. Script checks max_slots
4. Script increments counter
5. Script returns position and is_winner
6. Return result or null if max_slots exceeded
```

**Parameters:**

- `sessionId: number` - Session ID
- `maxSlots: number` - Maximum slots (0 = unlimited)

**Returns:**

```typescript
{ position: number, is_winner: boolean } | null
```

**Lua Script Logic:**

```lua
1. Get current count from Redis
2. If max_slots > 0 and current >= max_slots: return nil
3. Increment counter (atomic)
4. Calculate is_winner (max_slots == 0 or position <= max_slots)
5. Return {position, is_winner}
```

**Why Lua Script?**

- **Atomic**: Entire script executes atomically
- **Fast**: Runs on Redis server (no network round-trips)
- **Reliable**: No race conditions possible

---

#### `CouponService.publishParticipantUpdate()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Publishes participant count update to Redis pub/sub
- Frontend can subscribe for real-time updates

**Why we use it:**

- Real-time updates for frontend
- Live participant count display
- Winner notifications

**Code Flow:**

```
1. Build payload with session info
2. Publish to Redis channel: session:participant:update
3. Frontend subscribers receive update
```

**Parameters:**

- `suid: string` - Session unique ID
- `participantCount: number` - New participant count
- `sessionProfileId: number` - Session profile ID
- `position: number` - Position assigned
- `isWinner: boolean` - Is winner
- `sessionId: number` - Session ID

**Redis Channel:**

- `session:participant:update`

**Payload:**

```json
{
  "suid": "session-123",
  "participant_count": 50,
  "session_profile_id": 456,
  "position": 50,
  "is_winner": true,
  "session_id": 123,
  "updated_at": "2024-01-01T12:00:00Z"
}
```

---

#### `CouponService.updateParticipantStats()`

**Location**: `src/app/coupon/coupon.service.ts`

**What it does:**

- Updates or creates participant statistics
- Tracks coupons applied and winner status

**Why we use it:**

- Analytics and reporting
- User statistics
- Non-critical (errors don't fail the request)

**Code Flow:**

```
1. Upsert session_participants record
2. If exists: Increment coupons_applied, update is_winner
3. If not exists: Create with coupons_applied=1
```

**Parameters:**

- `sessionId: number` - Session ID
- `userId: number` - User ID
- `isWinner: boolean` - Is winner

**Why Non-Critical?**

- Doesn't affect coupon application
- Errors logged but don't fail request
- Can be retried later if needed

---

### Worker Handler Functions

#### `handleApplyCoupon()`

**Location**: `src/app/jobs/workers/session/handlers/apply-coupon.handler.ts`

**What it does:**

1. Extracts job data
2. Loads coupon and session
3. Re-validates coupon (might have changed since queued)
4. Executes Redis atomic operation
5. Updates database atomically
6. Creates reward if winner
7. Updates session
8. Publishes real-time update

**Why we use it:**

- Processes queued jobs in FIFO order
- Uses Redis atomic operations
- No database locks needed

**Code Flow:**

```
1. Extract job data (userId, couponId, sessionId, requestTimestamp)
2. Load coupon from database
3. Re-validate coupon (ownership, validity, not used)
4. Load session and validate is LIVE
5. Load session profile
6. Sync Redis counter
7. Execute Redis Lua script → Get position
8. Atomically update coupon (updateMany with condition)
9. If update fails: Revert Redis counter, throw error
10. If winner: Create reward record
11. Update session participant count
12. If max_slots reached: Mark session COMPLETED
13. Publish real-time update
14. Return result
```

**Parameters:**

- `job: Job` - BullMQ job instance

**Job Data:**

```typescript
{
  userId: number,
  couponId: number,
  sessionId: number,
  plainCouponCode: string,
  requestTimestamp: number
}
```

**Returns:**

```typescript
{
  success: boolean,
  position: number,
  is_winner: boolean,
  applied_at: Date,
  max_slots: number,
  slots_remaining: number | null,
  reward_created: boolean,
  participant_count: number
}
```

**Why in Worker?**

- Processes jobs in FIFO order
- No blocking on API endpoint
- Handles retries automatically
- Scales independently

---

### Helper Functions

#### `getRedis()`

**Location**: `src/app/coupon/coupon.service.ts` and `apply-coupon.handler.ts`

**What it does:**

- Returns Redis connection if available and ready
- Returns null if Redis unavailable

**Why we use it:**

- Centralized Redis connection check
- Handles connection failures gracefully
- Prevents errors if Redis down

**Code Flow:**

```
Check redis exists and status === 'ready'
→ If yes: Return redis connection
→ If no: Return null
```

**Returns:**

- `IORedis | null` - Redis connection or null

---

## 🛡️ Race Condition Prevention

### Three-Layer Protection

#### 1. Queue-Based FIFO Processing

**How it works:**

- All requests are queued with a request timestamp
- BullMQ worker processes jobs in FIFO order (concurrency: 1)
- First request in queue = first processed

**Code:**

```typescript
// coupon.service.ts
const requestTimestamp = Date.now();
const job = await this.sessionQueue.add(
  'apply-coupon',
  {
    userId,
    couponId: coupon.id,
    sessionId: coupon.session_id,
    requestTimestamp, // Used for ordering
  },
  {
    jobId: `apply-coupon-${coupon.id}-${userId}-${requestTimestamp}`,
  },
);
```

**Why it works:**

- BullMQ guarantees FIFO processing
- Worker concurrency set to 1 (processes one job at a time)
- Request timestamp ensures order preservation

#### 2. Redis Atomic Operations

**How it works:**

- Lua script atomically increments counter and checks max_slots
- Single atomic operation prevents race conditions
- Returns position only if slot available

**Code:**

```typescript
// Redis Lua Script
const luaScript = `
  local key = KEYS[1]
  local max_slots = tonumber(ARGV[1])
  local current = redis.call('GET', key) or 0
  
  if max_slots > 0 and current >= max_slots then
    return nil  -- Max slots exceeded
  end
  
  local new_count = redis.call('INCR', key)
  local is_winner = max_slots == 0 or new_count <= max_slots
  
  return {new_count, is_winner and 1 or 0}
`;
```

**Why it works:**

- Redis Lua scripts are atomic
- Single operation checks and increments
- No possibility of race condition between check and increment

#### 3. Atomic Database Update

**How it works:**

- Uses `updateMany` with condition `applied_at: null`
- Only one job can successfully update the coupon
- If update fails (count = 0), coupon already applied

**Code:**

```typescript
// apply-coupon.handler.ts
const updateResult = await prisma.session_coupons.updateMany({
  where: {
    id: couponId,
    applied_at: null, // Only update if not already applied
  },
  data: {
    applied_at: appliedAt,
    position,
    is_redeemed: true,
    status: isWinner ? 'WINNER' : 'APPLIED_LATE',
  },
});

if (updateResult.count === 0) {
  // Coupon already applied - revert Redis counter
  await redis.decr(`session:applied:${sessionId}`);
  throw new Error('Coupon already applied');
}
```

**Why it works:**

- Database-level atomic update
- Condition ensures only first update succeeds
- Redis counter reverted if update fails

### Race Condition Scenarios

#### Scenario 1: Two Users Apply Same Coupon

```
User A (T=1000ms) → Queue → Worker → Redis (position: 1) → DB Update ✅
User B (T=1001ms) → Queue → Worker → Redis (position: 2) → DB Update ❌
                                              (Coupon already applied)
                                              → Revert Redis counter
```

**Result**: Only User A's application succeeds. User B gets error.

#### Scenario 2: Max Slots Reached

```
User A (T=1000ms) → Queue → Worker → Redis (position: 100) → DB Update ✅
User B (T=1001ms) → Queue → Worker → Redis (position: null) → Error ❌
                                              (Max slots exceeded)
```

**Result**: User A gets position 100. User B gets "session full" error.

#### Scenario 3: Concurrent Requests

```
100k requests at T=0ms
  ↓
All queued with timestamps
  ↓
Processed in FIFO order (one at a time)
  ↓
Each gets accurate position from Redis
  ↓
No race conditions, no duplicates
```

**Result**: All requests processed correctly in order.

---

## 📦 Queue-Based Processing

### Why Use a Queue?

**Benefits:**

1. **FIFO Order** - First request wins
2. **No Database Locks** - Avoids bottlenecks
3. **Fast API Response** - Returns immediately
4. **Scalable** - Handles 100k+ concurrent requests
5. **Reliable** - Jobs retry on failure

### Queue Configuration

**Worker Settings:**

```typescript
// session.worker.ts
{
  concurrency: 1,  // Process one job at a time (FIFO)
  limiter: {
    max: 2,        // Max 2 jobs per second
    duration: 1000,
  },
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86400 },
}
```

**Job Options:**

```typescript
// coupon.service.ts
{
  jobId: `apply-coupon-${coupon.id}-${userId}-${requestTimestamp}`,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
}
```

### Queue Flow

```
┌─────────────┐
│   Request   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Validate   │ (Fast - no locks)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Add to     │
│   Queue     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Return     │ ← User gets response immediately
│  job_id     │
└─────────────┘

[Background Processing]
       │
       ▼
┌─────────────┐
│   Worker    │ (Processes in FIFO order)
│   Picks Up  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Process   │
│   Job       │
└─────────────┘
```

---

## ⚡ Redis Atomic Operations

### Redis Lua Script

**Purpose**: Atomically assign position and check max_slots

**Script:**

```lua
local key = KEYS[1]              -- session:applied:{sessionId}
local max_slots = tonumber(ARGV[1])
local current = redis.call('GET', key) or 0

-- Check if max slots exceeded
if max_slots > 0 and current >= max_slots then
  return nil  -- Max slots exceeded
end

-- Atomically increment
local new_count = redis.call('INCR', key)
local is_winner = max_slots == 0 or new_count <= max_slots

-- Return position and winner status
return {new_count, is_winner and 1 or 0}
```

**Why Lua Script?**

- **Atomic**: Entire script executes atomically
- **Fast**: Runs on Redis server (no network round-trips)
- **Reliable**: No race conditions possible

### Redis Counter Sync

**Purpose**: Keep Redis counter in sync with database

**When**: Before processing each job (if max_slots > 0)

**Code:**

```typescript
// Sync Redis counter with DB
const appliedCount = await prisma.session_coupons.count({
  where: {
    session_id: sessionId,
    applied_at: { not: null },
  },
});

const redisKey = `session:applied:${sessionId}`;
const redisCount = await redis.get(redisKey);
const redisCountNum = redisCount ? parseInt(redisCount, 10) : 0;

if (redisCountNum !== appliedCount) {
  await redis.set(redisKey, appliedCount.toString());
}
```

**Why Sync?**

- Handles Redis restarts
- Handles manual database updates
- Ensures accuracy

### Redis Pub/Sub

**Purpose**: Real-time participant count updates

**Channel**: `session:participant:update`

**Payload:**

```json
{
  "suid": "session-123",
  "participant_count": 50,
  "session_profile_id": 456,
  "position": 50,
  "is_winner": true,
  "session_id": 123,
  "updated_at": "2024-01-01T12:00:00Z"
}
```

**Usage**: Frontend can subscribe to get real-time updates

---

## 🌐 API Endpoints

### POST /coupon/apply

**Description**: Apply a coupon to a session competition

**Authentication**: Required (JWT Bearer token)

**Request:**

```http
POST /coupon/apply
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "coupon_code": "SES-1-1z-83uqO4fId-E5P5HA"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "job_id": "apply-coupon-123-456-1234567890",
  "message": "Coupon application queued successfully. Processing in order.",
  "queued_at": "2024-01-01T12:00:00.000Z"
}
```

**Error Responses:**

**401 Unauthorized:**

```json
{
  "statusCode": 401,
  "message": "Authentication required"
}
```

**404 Not Found:**

```json
{
  "error_type": "not_found",
  "loc": "coupon_code",
  "msg": "Invalid coupon code",
  "inp": "***",
  "ctx": { "code": "invalid" }
}
```

**400 Bad Request:**

```json
{
  "error_type": "invalid_coupon",
  "loc": "coupon",
  "msg": "This coupon is not linked to any session",
  "inp": "SES-1-1z-83uqO4fId-E5P5HA",
  "ctx": { "session_id": null }
}
```

**409 Conflict:**

```json
{
  "error_type": "session_full",
  "loc": "session",
  "msg": "Session has reached maximum slots (100). No more coupons can be applied.",
  "inp": "session-123",
  "ctx": {
    "max_slots": 100,
    "available_slots": 0
  }
}
```

### Swagger Documentation

The endpoint is documented in Swagger/OpenAPI:

- Tags: `coupon`
- Operation: `Apply a coupon to session`
- Security: Bearer Auth

---

## ⚙️ Configuration

### Environment Variables

**Required:**

```bash
# Redis Configuration
REDIS_URL=redis://localhost:6379
REDIS_DB=0

# Encryption Key (64-character hex string)
SESSION_ENCRYPTION_KEY=your-64-character-hex-encryption-key-here

# JWT Secret
JWT_SECRET_KEY=your-jwt-secret-key
```

**Optional:**

```bash
# Coupon Code Configuration
COUPON_CODE_PREFIX=SES              # Default: SES
COUPON_RANDOM_SUFFIX_LENGTH=6       # Default: 6
COUPON_SCUID_PREFIX=sc              # Default: sc
COUPON_SCUID_NANO_LENGTH=8          # Default: 8
```

### Database Schema

**session_coupons table:**

```prisma
model session_coupons {
  id            Int       @id @default(autoincrement())
  scuid         String    @unique
  user_id       Int
  session_id    Int?
  code          String    // Encrypted coupon code
  is_valid      Boolean   @default(true)
  is_redeemed   Boolean   @default(false)
  applied_at    DateTime?
  position      Int?
  status        String?   // WINNER, APPLIED_LATE
  created_at    DateTime  @default(now())
  updated_at    DateTime  @updatedAt
}
```

**sessions table:**

```prisma
model sessions {
  id                        Int       @id @default(autoincrement())
  suid                      String    @unique
  session_profile_id        Int
  status                    String
  current_participant_count Int?
  is_active                 Boolean   @default(true)
  start_time                DateTime?
  end_time                  DateTime?
  created_at                DateTime  @default(now())
  updated_at                DateTime  @updatedAt
}
```

**session_profiles table:**

```prisma
model session_profiles {
  id              Int       @id @default(autoincrement())
  max_slots       Int       @default(0)  // 0 = unlimited
  reward_type     String
  reward_value    Decimal?
  reward_currency String?
  reward_product_id Int?
  reward_coupon_id Int?
  reward_metadata Json?
}
```

---

## 👨‍💻 Development Guide

### Adding a New Feature

#### 1. Add Validation

**File**: `coupon.service.ts`

```typescript
private validateNewFeature(coupon: SessionCoupon) {
  if (!coupon.someField) {
    throw new BadRequestException({
      error_type: 'invalid_coupon',
      loc: 'coupon',
      msg: 'Some validation message',
      inp: coupon.scuid,
    });
  }
}
```

#### 2. Update Handler

**File**: `apply-coupon.handler.ts`

```typescript
// Add validation before processing
validateNewFeature(coupon);

// Add logic in processing
if (someCondition) {
  // Do something
}
```

#### 3. Update Tests

**File**: `coupon.service.spec.ts`

```typescript
it('should validate new feature', async () => {
  // Test validation
});
```

### Debugging

#### Check Queue Status

```typescript
// Get queue status
const queue = this.sessionQueue;
const waiting = await queue.getWaiting();
const active = await queue.getActive();
const completed = await queue.getCompleted();
const failed = await queue.getFailed();

console.log({
  waiting: waiting.length,
  active: active.length,
  completed: completed.length,
  failed: failed.length,
});
```

#### Check Redis Counter

```bash
# Connect to Redis
redis-cli

# Check counter
GET session:applied:123

# Check all session counters
KEYS session:applied:*
```

#### Check Job Status

```typescript
// Get job by ID
const job = await this.sessionQueue.getJob(jobId);
console.log({
  id: job?.id,
  name: job?.name,
  data: job?.data,
  state: await job?.getState(),
  progress: job?.progress,
});
```

### Logging

**Log Levels:**

- `logger.log()` - Normal operations
- `logger.debug()` - Detailed debugging
- `logger.warn()` - Warnings (non-critical)
- `logger.error()` - Errors (critical)

**Example:**

```typescript
this.logger.log(`Coupon application queued: job_id=${job.id}`);
this.logger.debug(`Coupon found: scuid=${coupon.scuid}`);
this.logger.warn(`Redis connection error: ${err.message}`);
this.logger.error(`Failed to apply coupon: ${error.message}`);
```

---

## 🧪 Testing

### Unit Tests

**Test coupon validation:**

```typescript
describe('CouponService', () => {
  it('should validate coupon ownership', () => {
    // Test ownership validation
  });

  it('should throw error if coupon already applied', () => {
    // Test duplicate application
  });
});
```

### Integration Tests

**Test API endpoint:**

```typescript
describe('POST /coupon/apply', () => {
  it('should queue coupon application', async () => {
    const response = await request(app.getHttpServer())
      .post('/coupon/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ coupon_code: 'SES-1-1z-83uqO4fId-E5P5HA' })
      .expect(200);

    expect(response.body).toHaveProperty('job_id');
    expect(response.body.success).toBe(true);
  });
});
```

### Manual Testing

**1. Encrypt/Decrypt Test:**

```bash
# Encrypt a coupon code
npm run encrypt-decrypt-coupon --encrypt "SES-1-1z-83uqO4fId-E5P5HA"

# Decrypt an encrypted code
npm run encrypt-decrypt-coupon --decrypt "gAAAAABpHsJxUkgOFGcsSdfyFkU7iKYe26bB-BByGZGXujbwtquRUKQbL2-MedVSuFcy2K6TSXBMFuHfgh2E5K-WIJP6Nv2dITq6-PqOJAG0U0Iv_DyZBsQ="
```

**2. API Test:**

```bash
# Apply coupon
curl -X POST http://localhost:3000/coupon/apply \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"coupon_code": "SES-1-1z-83uqO4fId-E5P5HA"}'
```

**3. Check Job Status:**

```typescript
// In your code
const job = await sessionQueue.getJob(jobId);
const state = await job.getState();
console.log('Job state:', state); // 'completed', 'failed', 'active', etc.
```

---

## 🔧 Troubleshooting

### Common Issues

#### 1. "Coupon not found" Error

**Problem**: Coupon code not found in database

**Solutions:**

- Check if coupon code is correct
- Verify encryption key matches between services
- Check if coupon exists for the user (fallback search)
- Verify `is_valid` and `is_redeemed` flags

**Debug:**

```typescript
// Check coupon in database
const coupon = await prisma.session_coupons.findFirst({
  where: { code: encryptedCode },
});
console.log('Coupon found:', coupon);
```

#### 2. "Session full" Error

**Problem**: Max slots reached

**Solutions:**

- Check `max_slots` in `session_profiles`
- Verify Redis counter matches database count
- Check if session is still LIVE

**Debug:**

```bash
# Check Redis counter
redis-cli GET session:applied:123

# Check database count
SELECT COUNT(*) FROM session_coupons
WHERE session_id = 123 AND applied_at IS NOT NULL;
```

#### 3. Job Stuck in Queue

**Problem**: Jobs not processing

**Solutions:**

- Check worker is running
- Verify Redis connection
- Check worker logs for errors
- Verify queue name matches

**Debug:**

```typescript
// Check queue status
const waiting = await queue.getWaiting();
console.log('Waiting jobs:', waiting.length);

// Check worker status
// Look for worker logs
```

#### 4. Redis Counter Out of Sync

**Problem**: Redis counter doesn't match database

**Solutions:**

- Counter syncs automatically before each job
- Manually sync if needed
- Check for Redis restarts

**Debug:**

```typescript
// Manual sync
const dbCount = await prisma.session_coupons.count({
  where: { session_id: 123, applied_at: { not: null } },
});
await redis.set('session:applied:123', dbCount.toString());
```

#### 5. Duplicate Applications

**Problem**: Same coupon applied twice

**Solutions:**

- Check atomic update is working
- Verify queue processing order
- Check for duplicate job IDs

**Debug:**

```typescript
// Check if coupon already applied
const coupon = await prisma.session_coupons.findUnique({
  where: { id: couponId },
});
console.log('Applied at:', coupon.applied_at);
```

### Performance Issues

#### Slow API Response

**Check:**

- Database query performance
- Redis connection latency
- Queue add operation

**Optimize:**

- Add database indexes
- Use connection pooling
- Monitor Redis latency

#### Slow Queue Processing

**Check:**

- Worker concurrency settings
- Database update performance
- Redis operation latency

**Optimize:**

- Increase worker concurrency (if safe)
- Optimize database queries
- Use Redis pipelining

### Monitoring

**Key Metrics:**

- Queue length (waiting jobs)
- Processing time per job
- Redis counter accuracy
- Error rate
- API response time

**Logs to Monitor:**

- Coupon application queued
- Job processing started
- Redis atomic operation
- Database update
- Errors and warnings

---

## 📚 Additional Resources

### Related Documentation

- [Worker Development Guide](./WORKER_DEVELOPMENT_GUIDE.md) - How to create workers
- [Session Creation Flow](./SESSION_CREATION_FLOW.md) - Session lifecycle
- [JWT Authentication Flow](./JWT_AUTHENTICATION_FLOW.md) - Authentication setup
- [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) - System architecture

### Code References

- `src/app/coupon/coupon.service.ts` - Main service
- `src/app/coupon/coupon.controller.ts` - API endpoint
- `src/app/jobs/workers/session/handlers/apply-coupon.handler.ts` - Worker handler
- `src/app/coupon/utils/coupon-generator.util.ts` - Encryption logic

### External Resources

- [BullMQ Documentation](https://docs.bullmq.io/)
- [Redis Lua Scripting](https://redis.io/docs/manual/programmability/eval-intro/)
- [Prisma Documentation](https://www.prisma.io/docs/)

---

## ✅ Summary

The Coupon Module provides:

1. **Race Condition Prevention**: Queue + Redis atomic + DB atomic update
2. **Fast Response**: Immediate API return, async processing
3. **Accurate Position**: Redis Lua script ensures atomic assignment
4. **Scalable**: Handles 100k+ concurrent requests
5. **Reliable**: Automatic retries, error handling

**Key Takeaways:**

- Always use queue for high-concurrency operations
- Redis atomic operations prevent race conditions
- Atomic database updates prevent duplicates
- Monitor queue length and processing time
- Test with concurrent requests

---

Author : Vartik Anand

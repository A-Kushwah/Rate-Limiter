# Rate Limiter

A small Node + Redis project for comparing a few rate-limiting strategies side by side. I wanted something I could run locally, throw traffic at, and watch how each algorithm behaves.

> **Live demo:** https://rate-limiter-j4km.onrender.com
> 
---

## Why I built it

I kept running into the gap between reading about rate limiting and actually seeing it behave under pressure. The simple version works fine in a toy example, but it falls apart once requests hit at the same time. This project is mostly a sandbox for that: Redis-backed checks, a few different algorithms, and a basic dashboard so the behavior is visible instead of abstract.

---

## Architecture

```
                         ┌──────────────────────────────────────────┐
                         │              Client / Browser            │
                         │   (curl, autocannon, dashboard, app)     │
                         └──────────────────┬───────────────────────┘
                                            │  HTTP / WebSocket
                                            ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       Express server (Node.js)                        │
│  ┌──────────────┐    ┌──────────────────────────┐    ┌─────────────┐  │
│  │ Demo API     │ ←→ │  rate-limit middleware   │ ←→ │  events     │  │
│  │ /api/search  │    │  (resolves key, picks    │    │  pub/sub    │  │
│  │ /api/login   │    │   algorithm, sets Hdrs,  │    │  (in-proc)  │  │
│  │ /api/me      │    │   emits dashboard event) │    └─────┬───────┘  │
│  │ /api/expensive│   └────────────┬─────────────┘          │          │
│  └──────────────┘                │                         │          │
│                                  ▼                         ▼          │
│                       ┌──────────────────────┐   ┌──────────────────┐ │
│                       │  algorithms/check()  │   │  WebSocket /ws   │ │
│                       │  (5 algos, uniform   │   │  → dashboard     │ │
│                       │   return shape)      │   │  live stream     │ │
│                       └──────────┬───────────┘   └──────────────────┘ │
└──────────────────────────────────┼────────────────────────────────────┘
                                   │  EVALSHA  (one round trip)
                                   ▼
                        ┌────────────────────────┐
                        │        Redis           │
                        │  Lua scripts (atomic)  │
                        │  - fixed_window        │
                        │  - sliding_log         │
                        │  - sliding_window      │
                        │  - token_bucket        │
                        │  - leaky_bucket        │
                        └────────────────────────┘
```

**Key flow** for one request:

1. Express receives a request to `/api/...`.
2. The global limiter middleware resolves a client identity (API key, user id, IP, or a composite) based on `KEY_STRATEGY`.
3. It picks the algorithm and limits from the most specific `ROUTES_JSON` override, or falls back to the global defaults.
4. It calls `algorithms.check(algo, scope, id, opts)`, which issues a single `EVALSHA` to Redis. The Lua script does read–modify–write atomically, so even with 1,000 concurrent requests the count is exact.
5. The response includes `X-RateLimit-Limit / Remaining / Reset`. If blocked, the response is 429 with `Retry-After`.
6. An event is published to the in-process pub/sub; the WebSocket server fans it out to the dashboard.

---

## How the algorithms differ

| Algorithm | Memory / key | Accuracy | Burst behavior | Best for |
|---|---|---|---|---|
| **Fixed Window Counter** | O(1) | approximate | Up to 2× limit at window boundary | rough abuse prevention, very cheap |
| **Sliding Window Log** | O(limit) | exact | No extra burst | low-volume, accuracy-critical (financial) |
| **Sliding Window Counter (hybrid)** | O(1) | ~1% error | bounded to ~2× limit | **production default** |
| **Token Bucket** | O(1) | exact | Allows burst up to `limit + burst` | APIs that benefit from short spikes (login retries, search) |
| **Leaky Bucket** | O(1) | exact | Smooths output, no extra burst | downstream services needing steady rate |

### 1. Fixed Window Counter
- **How it works:** Each request `INCR`s a counter for the current wall-clock window (e.g. minute). When the counter exceeds the limit, the request is blocked. The key auto-expires at the end of the window.
- **Tradeoff:** Cheap and simple, but a client can send `LIMIT` requests at 11:59:59 and another `LIMIT` at 12:00:00 — **2× the limit in 1 second**. For an external-facing public API this is usually fine; for an internal one against a fragile downstream it's not.

### 2. Sliding Window Log
- **How it works:** Stores every request's timestamp in a sorted set. On each new request, drops everything older than the window, then checks the size.
- **Tradeoff:** **Exact** — no boundary double-burst. But memory is O(limit) per key. With limit=10000 this is 10000 sorted-set entries per active client. Don't use it for high-volume public APIs.

### 3. Sliding Window Counter (hybrid) — **most production-realistic**
- **How it works:** Tracks the count for the *current* window and the *previous* window. Estimates the rolling count as `cur + prev × (1 − elapsed/window)`. This is the formula Cloudflare documents in their blog post.
- **Tradeoff:** O(1) memory, accuracy within ~1% for smooth traffic. The worst case (a huge burst at the window boundary) is bounded to ~2× the limit — still a real bound, unlike naive fixed window.

### 4. Token Bucket
- **How it works:** Imagine a bucket that fills with tokens at a steady rate (e.g. 1/sec). Each request takes one token. If the bucket is empty, the request is blocked. The bucket has a maximum capacity of `limit + burst`, so a long-idle client can spend accumulated tokens all at once.
- **Tradeoff:** Best algorithm when bursts are useful: a search client that hasn't searched in 5 minutes should be allowed to issue a few searches quickly. **This is the default in this project.**

### 5. Leaky Bucket
- **How it works:** Each request adds 1 unit of "water" to a bucket. The bucket leaks at a constant rate. If the bucket is full, the new request is dropped.
- **Tradeoff:** Constant *output* rate regardless of input — useful when the thing downstream of the rate limiter (a database, a partner API) cannot tolerate bursts. Slightly less user-friendly than token bucket because the client can't "save up" and burst.

### Why Lua scripts (the part most candidates get wrong)

A naive Redis implementation:

```js
// WRONG — has a race condition under concurrency
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, ttl);
if (count > limit) return block();
```

The problem: between `INCR` and `EXPIRE`, the process can crash, leaving a key with no TTL. Between `INCR` and the `if`, a thousand other clients can also `INCR`, and you've already let too many through before you decide to block. The correct fix is **atomic** execution on the Redis server.

This project uses one Lua script per algorithm. Each script is loaded once with `SCRIPT LOAD` and called with `EVALSHA` for cheap execution. The whole read-modify-write happens inside a single Redis command — no other client can interleave. ioredis transparently falls back to `EVAL` on `NOSCRIPT` and reloads.

The relevant code lives in `src/lua/*.lua`. The dispatcher in `src/algorithms/index.js` is a single `switch` on algorithm; the middleware in `src/middleware/limiter.js` is algorithm-agnostic. If you add a sixth algorithm, you add one Lua file and one `case` in the switch — the rest of the system doesn't change.

---

## API

| Endpoint | Method | Limit (default) | Notes |
|---|---|---|---|
| `/health` | GET | none | `{ok, redis, algorithm, uptimeSec}` |
| `/config` | GET | none | Current effective configuration |
| `/config` | POST | none | Body `{algorithm: "..."}` to switch active algorithm at runtime |
| `/api/search` | GET | 100 / min + burst 50 | Demo |
| `/api/login` | POST | 5 / min, fixed window | Demo — deliberately strict |
| `/api/me` | GET | 60 / min | Demo |
| `/api/expensive` | GET | 60 / min | Demo |
| `/ws` | WS | n/a | Live event stream for the dashboard |

All `/api/*` responses include:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1718212345
```

When blocked:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 17
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1718212362

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded for POST /api/login",
  "limit": 5,
  "windowMs": 60000,
  "retryAfterMs": 17000
}
```

---

## Run it locally

### Option A: Docker (recommended)

```bash
git clone <this-repo>
cd rate-limiter
cp .env.example .env
docker compose up --build
# → http://localhost:3000          (dashboard)
# → http://localhost:3000/health   (health check)
# → http://localhost:3000/api/search?q=hello
```

### Option B: bare Node + local Redis

Requires Node 18+ and a running Redis on `localhost:6379`.

```bash
npm install
REDIS_URL=redis://127.0.0.1:6379 npm start
```

### Switch the algorithm at runtime

```bash
curl -X POST http://localhost:3000/config \
  -H 'content-type: application/json' \
  -d '{"algorithm":"sliding-window"}'
```

The dashboard's algorithm dropdown does the same thing — pick one and fire a burst; you'll see the green/red pattern change in real time.

### Run the tests

```bash
npm test
```

This exercises every algorithm's correctness — boundary cases, refilling, race-condition safety with 100 concurrent requests. Needs a reachable Redis (the tests use the same `REDIS_URL` as the app).

### Run the load test

```bash
# In one terminal — a low-limit instance so 429s are easy to see:
ALGORITHM=fixed-window LIMIT=10 BURST=0 npm start

# In another:
node scripts/loadtest.js http://localhost:3000
```

You'll see output like:

```
========= Load Test Report =========
Target:           http://localhost:3000/api/search?q=test
Duration:         10s
Connections:      50  (pipelining=1)
Total requests:   5000
HTTP 200:         10
HTTP 429:         4990
Throughput:       500 req/s (avg)
Latency p50:      4 ms
Latency p99:      12 ms
====================================
```

That asymmetry (10 OK, 4990 blocked) is the proof: the limiter held the line at exactly the configured limit while sustaining 500 requests/second.

---

## Deployment — Render (free tier, recommended)

I picked Render here because it was the easiest setup for a simple demo:
- **Free** web service tier (it spins down after 15 minutes of idle, but that is fine for a portfolio-style demo).
- **Free** Redis via Upstash (Render's own Key Value Store is paid-only).
- The Dockerfile works cleanly without much platform-specific fuss.
- It gives me a public URL on a `*.onrender.com` subdomain without much setup.

### Steps

1. **Push this repo to GitHub** (if you haven't).
2. **Create a free Upstash Redis** at https://upstash.com (free tier: 10k commands/day, 256MB, more than enough for a portfolio demo).
   - Create a new Redis database.
   - Copy the **Redis URL** (it looks like `rediss://default:<password>@<host>.upstash.io:6379` — note the double `s`).
   - Upstash requires TLS, so make sure you use the `rediss://` URL.
3. **Create a new Web Service on Render** at https://render.com.
   - Connect your GitHub repo.
   - **Environment**: `Docker`.
   - **Region**: pick the same one as your Upstash DB if possible.
   - **Plan**: Free.
4. **Set environment variables** in the Render dashboard:

   | Key | Value |
   |---|---|
   | `REDIS_URL` | (paste your Upstash URL) |
   | `ALGORITHM` | `token-bucket` |
   | `LIMIT` | `60` |
   | `BURST` | `20` |
   | `WINDOW_MS` | `60000` |
   | `KEY_STRATEGY` | `ip` |
   | `DASHBOARD_ENABLED` | `true` |
   | `ROUTES_JSON` | `{"POST /api/login":{"limit":5,"windowMs":60000,"burst":0,"algorithm":"fixed-window"}}` |

5. Click **Deploy**. The first build takes ~2 min.
6. Once the deploy is green, visit `https://<your-service>.onrender.com` — that's the dashboard. Hit `/health` to confirm Redis is reachable from Render.
7. **Cold starts**: on the free tier the service sleeps after 15 min of inactivity. The first request after that takes ~5s. Not great for the dashboard demo, but free.

### Alternative: Fly.io

Fly.io's free tier gives you 3 shared VMs with 256MB each, which fits both the app and a Redis. The Dockerfile works as-is; you'd `fly launch`, then `fly redis create` and `fly secrets set REDIS_URL=...`. I picked Render only because the Upstash integration is one click and the deploy-from-GitHub path is the most "resume-friendly" to screenshot.

---

## If I wanted to scale this further

This setup is enough for a small-to-medium API on one Redis. If I wanted to push it further, the next steps would be:

1. **Redis with replicas + Sentinel/Cluster.** When one box can no longer keep up with the Lua call rate, shard by client. A common pattern: `shard = crc16(clientId) % N`, route to one of N Redis primaries. The Lua scripts are already key-namespaced; you just need a consistent-hash layer in front.

2. **Sliding-window approximation at scale.** The hybrid sliding-window algorithm is already O(1) memory, but a "very large" client base still means a lot of keys. Replace the previous-window count with a HyperLogLog or a probabilistic counter (e.g. t-digest) — accuracy drops, memory drops by 10× or more. Good for analytics-style rate limits ("this client did ~1M requests today, block at 2M"); not for the 5-per-minute login case.

3. **Edge rate limiting.** Move the limiter closer to the user. Cloudflare's rate-limit rules and AWS WAF both let you enforce limits at the edge — before the request even reaches your origin. Use the in-Redis limiter for *per-client* finer-grained limits and the edge limiter for *per-IP* coarse limits. The Lua scripts remain authoritative; the edge is just a fast first line of defense.

4. **Per-tenant fairness.** A single noisy tenant shouldn't be able to swamp the limiter for everyone. A "token budget" per tenant allocated periodically (a "leaky bucket of buckets") is a common pattern. Adds one more layer of Lua.

5. **Metrics & tracing.** This project logs to stdout and exposes a `/health` JSON. For production you'd want Prometheus counters (`rate_limit_decisions_total{algorithm, allowed}`) and OpenTelemetry traces on the Lua call. ioredis emits command timings; piping those into a histogram is half a day of work.

6. **Decision observability.** A `429` today is opaque. Returning a "why" header (e.g. `X-RateLimit-Reason: burst-exceeded-after-quota`) makes debugging client misbehavior trivial. The Lua scripts already have the info; the middleware just needs to surface it.

7. **Replay-safe counters.** If you ever need to count across deploys or after a Redis flush, the in-memory counter model is wrong. Store the limit and window in a small signed manifest in Redis, not just the count — that lets you rotate the limiter config without resetting state.

---

## File tree

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── .github/workflows/tests.yml
├── server/
│   └── index.js              # Express + WebSocket bootstrap
├── src/
│   ├── config.js             # env -> typed config
│   ├── redis.js              # ioredis client w/ fail-open on disconnect
│   ├── events.js             # in-process pub/sub for dashboard
│   ├── algorithms/
│   │   ├── index.js          # dispatcher; calls one of the Lua scripts
│   │   └── (Lua files in src/lua/)
│   ├── lua/
│   │   ├── fixed_window.lua
│   │   ├── sliding_log.lua
│   │   ├── sliding_window.lua
│   │   ├── token_bucket.lua
│   │   └── leaky_bucket.lua
│   ├── middleware/
│   │   └── limiter.js        # the public middleware
│   ├── demo/
│   │   └── api.js            # example protected routes
│   └── dashboard/
│       └── index.html        # live dashboard (vanilla JS)
├── scripts/
│   └── loadtest.js           # autocannon-based load test
└── tests/
    └── algorithms.test.js    # node:test suite
```

---

## Notes for future me

- **One interface, several algorithms.** The middleware does not care which limiter is active; the dispatcher in `src/algorithms/index.js` is the only place the algorithm name really matters. Switching algorithms is mostly a config change or a small HTTP request.

- **The Redis/Lua part is the core.** The important bit is that the state change happens in one Redis-side operation. That is what avoids the classic race where a burst slips through because two requests read and write around the same time.

- **Redis downtime is handled loosely.** If Redis is unavailable, the app still serves requests and adds an `X-RateLimit-Error` header so the behavior is visible instead of silently failing.

- **Per-route overrides live in `ROUTES_JSON`.** The login endpoint is intentionally stricter than search, and the middleware picks the most specific prefix match.

- **The dashboard is mostly there to make behavior visible.** Switching from token-bucket to fixed-window changes the pattern immediately, which is useful when I want to compare algorithms without reading code.

- **If I keep going, I’d probably add metrics and better debug headers.** Prometheus-style counters and a `X-RateLimit-Reason` header would be the next useful pieces.

# OpenTable Reservation Sniper — Implementation Plan

## Goal
Add OpenTable search, booking, cancellation, and monitoring (casual + snipe) to Crabby,
achieving feature parity with the existing Resy implementation.

## Recommended API Approach: GraphQL (Henrymarks1/Open-Table-Bot)

OpenTable's GraphQL API is the most robust approach because:
- It's the primary modern API powering the web app (more stable than mobile v3)
- Supports the full booking flow: search → slot details → book
- Direct HTTP calls — no browser automation or heavyweight deps
- Best-documented by the Henrymarks1 project

### Authentication: Manual Token Extraction
User provides 3 values via setup script (extracted from browser dev tools → Network tab):
1. **CSRF Token** — from `X-Csrf-Token` request header
2. **Session Cookies** — from the `Cookie` request header (authenticated session)
3. **GPID** (diner profile ID) — from request payloads or account page

These get cached in SQLite (`opentable_auth` table) with the same pattern as Resy JWT caching.
Token refresh: detect 401/403 responses → prompt user to re-extract tokens.

---

## Files to Create

### 1. `src/opentable/types.ts` — API response types

```
OTSearchResponse        — availability results (mirrors ResySearchResponse)
OTSlot                  — individual time slot (mirrors ResySlot)
OTRestaurantResult      — venue + slots bundle (mirrors ResyVenueResult)
OTSlotDetails           — cancellation/deposit info (mirrors ResySlotDetails)
OTBookingConfirmation   — booking result (mirrors ResyBookingConfirmation)
OTReservation           — user's existing reservation (mirrors ResyReservation)
OTRestaurantSearchResult — venue lookup result
```

### 2. `src/opentable/client.ts` — HTTP API client

**Init & Auth (mirrors Resy client pattern):**
- `initOpenTableDb(dataDir)` — create `opentable_auth` table, load creds from env/file
- `getCachedAuth()` / `saveAuth()` — SQLite token cache
- `ensureFreshAuth()` — for snipe pre-auth validation
- `setSnipeMode(enabled)` — toggle rate limiting

**HTTP layer:**
- `buildHeaders(csrfToken, cookies)` — construct request headers
- `rateLimit()` — 500ms gap in normal mode, skip in snipe mode
- `otFetch(url, options)` — wrapper with rate limiting + 401 retry

**API functions (GraphQL + REST):**
- `searchAvailability(params)` — GraphQL query for available slots
  - Params: restaurantId, date, partySize, timeOption
  - Endpoint: `https://www.opentable.com/dapi/fe/gql` (POST, GraphQL)
- `findRestaurantByName(query)` — search for restaurant ID
  - Endpoint: `https://www.opentable.com/dapi/fe/gql` (autocomplete query)
- `getSlotDetails(slotToken, date, partySize)` — cancellation/deposit info
  - Endpoint: GraphQL mutation for slot lock/hold
- `bookSlot(slotToken, dinerInfo)` — complete the booking
  - Endpoint: GraphQL booking mutation
  - Payload: firstName, lastName, email, phone, slotToken
- `getMyReservations()` — list upcoming reservations
  - Endpoint: `https://www.opentable.com/dapi/fe/gql` (user reservations query)
- `cancelReservation(confirmationNumber)` — cancel booking
  - Endpoint: GraphQL cancellation mutation

**Key differences from Resy client:**
- Auth is CSRF + cookies (not JWT)
- Booking requires personal details in payload (Resy uses payment method ID)
- GraphQL vs REST for primary operations

### 3. `src/opentable/monitor.ts` — Reservation monitor

Exact structural mirror of `src/resy/monitor.ts`:

**SQLite table: `opentable_monitors`**
```sql
CREATE TABLE IF NOT EXISTS opentable_monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  restaurant_name TEXT NOT NULL,
  restaurant_id INTEGER,
  party_size INTEGER NOT NULL,
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  days_of_week TEXT,
  drop_time TEXT,
  drop_advance_days INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  booked_confirmation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Functions:**
- `initOpenTableMonitor(bot)` — start casual cron + schedule snipe jobs
- `stopOpenTableMonitor()` — cleanup
- `processCasualMonitors()` — 60s polling loop, check all active monitors
- `checkMonitor(monitor)` — search availability, try to book matches
- `scheduleSnipeJobs()` / `scheduleSnipeForMonitor(monitor)` — cron scheduling
- `executeSnipe(monitor, targetDate)` — pre-auth, wait, tight 1s poll for 30s
- `tryBookSlot(slots, day, monitor)` — iterate slots, get details, book first match
- `filterSlots(slots, timeStart, timeEnd)` — time window filter
- Helper functions: `getActiveMonitors`, `getMonitorDates`, `getSnipeDates`, etc.

### 4. `src/mcp/opentable-server/index.ts` — MCP server (9 tools)

| Tool | Description | Mirrors |
|------|-------------|---------|
| `opentable_search` | Search availability by date/party/restaurant | `resy_search` |
| `opentable_find_restaurant` | Look up restaurant by name → ID | `resy_find_venue` |
| `opentable_slot_details` | Get cancellation/deposit info | `resy_slot_details` |
| `opentable_book` | Book a reservation | `resy_book` |
| `opentable_my_reservations` | List upcoming reservations | `resy_my_reservations` |
| `opentable_cancel` | Cancel a reservation | `resy_cancel` |
| `opentable_create_monitor` | Create auto-booking monitor | `resy_create_monitor` |
| `opentable_list_monitors` | List active monitors | `resy_list_monitors` |
| `opentable_cancel_monitor` | Disable a monitor | `resy_cancel_monitor` |

### 5. `scripts/setup-opentable.sh` — Credential setup

Interactive script that guides user through:
1. Log into OpenTable in browser
2. Open Dev Tools → Network tab
3. Make any request (search for a restaurant)
4. Copy X-Csrf-Token header value
5. Copy full Cookie header value
6. Copy GPID from request payload
7. Enter personal details (name, email, phone — needed for booking payload)
8. Script writes to `.env` and updates `.mcp.json`

---

## Files to Modify

### 6. `.env.example` — Add OpenTable env vars
```
# OpenTable
OPENTABLE_CSRF_TOKEN=       # X-Csrf-Token from browser network traffic
OPENTABLE_COOKIES=          # Cookie header from authenticated session
OPENTABLE_GPID=             # Diner profile ID
OPENTABLE_FIRST_NAME=       # For booking payload
OPENTABLE_LAST_NAME=
OPENTABLE_EMAIL=
OPENTABLE_PHONE=
```

### 7. `.mcp.json` — Add opentable server entry
```json
"crabby-opentable": {
  "command": "npx",
  "args": ["tsx", "src/mcp/opentable-server/index.ts"],
  "cwd": "...",
  "env": {
    "DATA_DIR": "./data",
    "OPENTABLE_CSRF_TOKEN": "",
    "OPENTABLE_COOKIES": "",
    "OPENTABLE_GPID": "",
    "OPENTABLE_FIRST_NAME": "",
    "OPENTABLE_LAST_NAME": "",
    "OPENTABLE_EMAIL": "",
    "OPENTABLE_PHONE": ""
  }
}
```

### 8. `src/index.ts` — Init/shutdown OpenTable monitor
```typescript
import { initOpenTableMonitor, stopOpenTableMonitor } from "./opentable/monitor.js";

// After Resy init block:
try {
  initOpenTableMonitor(bot);
} catch (err) {
  logger.warn({ err }, "OpenTable monitor not initialized (credentials may not be configured)");
}

// In shutdown:
stopOpenTableMonitor();
```

### 9. `src/claude/system-prompt.ts` — Add OpenTable section
Add a new `## OpenTable Reservations` section analogous to the existing Resy section,
listing all 9 MCP tools and their usage patterns.

---

## Implementation Order

1. **Types** (`opentable/types.ts`) — define all interfaces
2. **Client** (`opentable/client.ts`) — HTTP client with auth, search, book, cancel
3. **Monitor** (`opentable/monitor.ts`) — casual + snipe polling
4. **MCP Server** (`mcp/opentable-server/index.ts`) — 9 tools
5. **Wiring** — `.env.example`, `.mcp.json`, `src/index.ts`, system prompt
6. **Setup script** (`scripts/setup-opentable.sh`)

## Rate Limiting Strategy

- Normal mode: 500ms between requests (same as Resy)
- Snipe mode: no delay between requests
- Key insight from OSS research: OpenTable blocks at <30s polling intervals for browser-based bots, but direct API calls with proper headers are less likely to trigger detection
- Use realistic User-Agent header
- Add jitter to casual polling (55-65s instead of exactly 60s)

## Key Risks & Mitigations

1. **Token expiry**: CSRF tokens and cookies expire. Detection: 401/403 on any API call → log warning + Telegram notification to user to re-extract tokens
2. **GraphQL schema changes**: OpenTable can change their schema. Mitigation: loose typing (like Resy types), graceful error handling
3. **Bot detection**: Rate limit conservatively, use realistic headers, add request jitter
4. **Booking requires personal info**: Unlike Resy (which uses payment method ID), OT needs name/email/phone in every booking payload — stored in env vars

## No New Dependencies Required
- Uses existing: `better-sqlite3`, `node-cron`, `grammy`, `@modelcontextprotocol/sdk`, `zod`
- All HTTP via native `fetch`

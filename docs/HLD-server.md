# Tournament Management System — Server-Side High-Level Design

| Field | Value |
|---|---|
| Document Type | High-Level Design (HLD) |
| Status | Draft |
| Version | 0.2 Draft |
| Date | 22 September 2026 |
| Author | Scott |
| Runtime | Node.js + Express |
| Entry Point | `group-server.js` |
| Companion | Tournament Scoring App — HLD (Android Client) |
| Audience | Developers, Collaborators, Technical Stakeholders |

---

## 1 — Document Purpose & How to Use This Document

This document describes the **server-side component** of the Tournament Management System — a Node.js/Express application hosted locally on the venue LAN during a live martial arts tournament. It is the companion to the *Tournament Scoring App — HLD (Android Client)*, which covers the Android tablet application used by ring volunteers.

**How to use this document:**

- **As LLM context:** Paste this document at the start of a new session to give a language model full architectural context without re-explaining from scratch.
- **As a collaborator briefing:** Share with any developer or stakeholder joining the project.
- **As a personal reference:** Use Section 9 as a living build checklist. Mark items as the work progresses.
- **As a design record:** Decisions made and questions still open are captured explicitly so context is not lost between sessions.

> **Scope Boundary**
> This document covers the server only: its modules, data models, API routes, non-functional requirements, open design questions, and build checklist. Android client details are out of scope here and are addressed in the companion HLD.

All checklist items in Section 9 begin as **Not Started ([ ])** unless explicitly marked as `[x]` (confirmed from prior code review) or `[~]` (in progress).

---

## 2 — System Overview

The **Tournament Management System server** (`tournament-server`) is a Node.js + Express application that acts as the single source of truth for all tournament data during a live event. It runs on a laptop or dedicated machine connected to the venue's Wi-Fi router and is accessed by:

- **Admin web UI** — a browser-based interface (served by the same Express app) used by the head table to set up the tournament, build groups, assign rings, and manage the event.
- **Android tablet clients** — the Tournament Scoring App running on volunteer tablets, connecting via HTTP REST on the LAN.

> **No Internet Required**
> The server is designed for fully offline, LAN-only operation. No cloud services, external APIs, or internet connectivity are required or expected during a tournament.

**Key technology choices:**

- **Language:** JavaScript (Node.js)
- **Framework:** Express.js
- **Persistence:** SQLite roster database for roster/group division data plus event-scoped JSON files for ring state. Group data is reconstructed from SQLite and cached in memory at runtime.
- **Transport:** HTTP REST (JSON). No WebSocket or SSE implemented yet — see Section 8.
- **Entry point:** `group-server.js`

---

## 3 — Module Architecture

The server is organized into a main entry point, a `backend/` directory containing route handlers and shared stores, and a `db/` directory for schema/import helpers.

```
tournament-server/
|-- group-server.js          # Entry point - Express app setup, static files, route mounting
|-- db/
|   |-- init.js              # Initializes the SQLite schema
|   `-- import-csv.js        # Imports roster CSV data into SQLite
|-- backend/
|   |-- competitorStore.js   # SQLite-backed competitor read store
|   |-- divisionRoutes.js    # Routes: group retrieval/build/save
|   |-- groupContract.js     # Normalizes group and competitor shapes
|   |-- groupStore.js        # Event-scoped in-memory cache for saved groups
|   |-- pages.js             # Static/admin page routes
|   |-- ringRoutes.js        # Routes: ring state, assignments, heartbeat, assistance
|   `-- groupBuilder.js      # Logic: builds match groups from competitor lists
`-- docs/
    `-- HLD-server.md        # This document
```

### 3.1 — `group-server.js` (Entry Point)

Bootstraps the Express application. Responsibilities:

- Initializes the Express app and configures middleware (JSON body parser, CORS, static file serving).
- Mounts route modules: `divisionRoutes` and `ringRoutes` under `/api/`.
- Registers the admin/head-table and ring-assignment pages.
- Starts the HTTP server on the configured port (default: `3000`).

### 3.2 — Persistence & Store Modules

The server uses a mixed persistence model:

- `db/tournament.db` (or the active event's `tournament.db`) stores competitor roster data.
- SQLite indexes are maintained for `firstName`, `lastName`, `associationNumber`, `rank`, `groupDivisionId`, and `groupDivisionNumber` to support search and ring lookup paths.
- `backend/groupStore.js` keeps the latest saved groups in an event-scoped cache and serves them dynamically to ring requests.
- `ring-assignments.json` (or the active event's copy) stores ring assignment/heartbeat state.

These stores are shared so route handlers read and write the same event state.

### 3.3 — `divisionRoutes.js` (Group Routes)

Handles group retrieval/build/save operations. Key routes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/groups` | List all groups |
| `GET` | `/api/groups/:groupId` | Get a group with its competitor list |
| `POST` | `/api/divisions/build` | Build groups from roster input |
| `POST` | `/api/divisions/save` | Persist normalized groups for the active event |

### 3.4 — `ringRoutes.js` (Ring Operation Routes)

Handles all live-event operations for rings — the primary interface for the Android tablet clients and the head table dashboard. The current implementation persists ring assignments, queue state, check-in progress, phase progress, and assistance flags.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rings/config` | Return ring options available to a tablet client |
| `POST` | `/api/rings/config` | Apply ring count/configuration |
| `GET` | `/api/rings` | List all rings and their current state |
| `GET` | `/api/rings/:ringId/bootstrap` | Load the current assignment for a ring |
| `POST` | `/api/rings/:ringId/request-group` | Load the current assignment for a ring |
| `GET` | `/api/rings/:ringId/current` | Return the current ring state |
| `POST` | `/api/rings/:ringId/queue` | Queue a group to a ring |
| `DELETE` | `/api/rings/:ringId/queue/:groupId` | Remove a group from the queue |
| `POST` | `/api/rings/:ringId/heartbeat` | Record periodic client contact and progress counters |
| `POST` | `/api/rings/:ringId/complete` | Mark the current group complete and advance to the next |
| `POST` | `/api/rings/:ringId/reset` | Clear the ring back to scratch |
| `POST` | `/api/rings/:ringId/assistance` | Request assistance from the head table |
| `POST` | `/api/rings/:ringId/assistance/clear` | Clear an active assistance request |

### 3.5 — `groupBuilder.js` (Group Building Logic)

Contains the algorithm that takes a division's competitor list and produces ordered match groups. Responsibilities:

- Accept a list of competitors and a scoring mode.
- Apply seeding, randomization, or bracket logic to produce a match schedule.
- Return an ordered list of groups ready to be assigned to rings.

---

## 4 — Data Model

Roster data and division assignments are stored in SQLite. Ring state is persisted as JSON files, while saved group structures are reconstructed from the database and cached in memory. The shapes below describe the de facto payloads used throughout the system.

### Competitor

```
competitorId       string    Unique identifier
firstName          string
lastName           string
beltRank           string    e.g. "White", "Brown", "Black"
ageGroup           string    e.g. "Adult", "Junior"
gender             string    "M" | "F" | "X"
school             string    Competitor's school/club name
divisionIds        string[]  Divisions this competitor is enrolled in
checkInStatus      string    Current check-in state
competitionEntries object    Per-discipline enrollment/status
groupDivisionId    string    Group identifier used for ring assignment
groupDivisionName  string    Denormalized group label
groupDivisionNumber number   First division number for the group
competitionDivisionNumber number Unique competition number within the group
```

### Division

```
divisionId         string    Unique identifier
name               string    Human-readable label
ageGroup           string
gender             string
beltRankRange      string    e.g. "White-Yellow" or "Black"
eventType          string    "point-sparring" | "flag-sparring" | "forms"
competitors        string[]  Competitor IDs enrolled
groups             string[]  Group IDs built from this division
```

### Group

```
groupId            string    Unique identifier
divisionId         string    Parent division
divisionName       string    Denormalized for display
groupName          string    e.g. "Ring 2 - Group A"
competitors        Competitor[]
scoringMode        string    Inherited from division eventType
groupDivisionNumber number   First division number used for this group
assignedRingId     string | null
status             string    "unassigned" | "queued" | "in-progress" | "complete"
```

### Ring

```
ringId             string    Unique identifier
ringLabel          string    e.g. "Ring 1"
phase              string    "idle" | "check-in" | "weapons" | "hyungs" | "sparring" | "awards"
currentGroupId     string | null
currentGroupName   string | null
queuedGroupIds     string[]  Upcoming groups assigned to this ring
completedGroupIds  string[]  Groups already completed on this ring
assignmentStartedAt string | null ISO timestamp for ring runtime
checkInCount       number    Completed check-ins
checkInTotal       number    Expected check-ins
phaseCompletedCount number   Completed items in the active phase
phaseTotalCount    number    Expected items in the active phase
phaseProgress      number    0-100 progress snapshot
assistanceType     string | null   "medical" | "arbitrator" | "general"
assistanceRequestedAt  string | null   ISO timestamp
tabletLabel        string | null
lastHeartbeatAt    string | null
```

### MatchResult

```
matchId            string
groupId            string
ringId             string
redCornerCompetitorId   string
blueCornerCompetitorId  string
redScore           number
blueScore          number
scoringMode        string
outcome            string    "red-win" | "blue-win" | "bye" | "DQ" | "walkover"
submittedAt        string    ISO timestamp
```

---

## 5 — API Summary

All endpoints are prefixed `/api/`. The server accepts and returns JSON. No authentication is implemented in the current version.

See Sections 3.3 and 3.4 for full route tables. The Android client consumes the ring routes exclusively; the admin web UI consumes both division and ring routes.

---

## 6 — Admin Web UI

The server serves a browser-based admin interface from its static file directory. This UI is used exclusively by the head table operator. It is not documented in detail here — it is a thin client over the same REST API described above.

**Known capabilities:**
- Import competitor list (CSV or manual entry)
- Configure divisions
- Trigger group building
- Assign groups to rings
- Monitor ring status across all rings
- Manage queue, assistance, and ring progress state

---

## 7 — Non-Functional Requirements

| Requirement | Target |
|---|---|
| **Availability** | Must run fully offline on venue LAN. No internet dependency. |
| **Performance** | API responses must complete within 200ms on a local LAN under normal load (<= 10 tablet clients). |
| **Persistence** | SQLite roster data preserves competitor and division state across restarts; ring state persists as event-scoped JSON. |
| **Scalability** | Designed for single-venue, single-event use. No multi-event or multi-venue support required. |
| **Compatibility** | Runs on Node.js LTS. No OS-specific dependencies. Should run on Windows laptop available at venue. |
| **Security** | No authentication currently. Physical access control assumed. See Section 8. |
| **Recoverability** | Event roster, group, and ring assignment data persist on disk. After a restart, live tablet clients must reconnect and resend current heartbeat/progress state. |

---

## 8 — Open Questions & Decisions

- **OPEN** — **Real-time updates:** The Android app uses `/api/rings/config`, `/api/rings/:ringId/request-group`, and `/api/rings/:ringId/heartbeat` on screen/ring change and every 60 seconds while assigned. WebSocket or SSE would still be a design option for push notifications.
- **OPEN** — **Data persistence/backup:** Roster data and ring/group state now persist to SQLite and event files, but the backup/export story for completed events is still not formalized.
- **OPEN** — **Authentication:** No login or role enforcement. All clients on the LAN can call any API endpoint. Future hardening may require an API key or session token. Decision pending.
- **OPEN** — **Competitor import format:** Manual entry and CSV import are referenced but the exact CSV schema is not finalized.
- **OPEN** — **Scoring mode support:** Point sparring is the primary confirmed mode. Flag sparring and forms/kata support still needs validation against tournament rules.
- **OPEN** — **Export/backup:** No formal end-of-event export/archive workflow is defined yet.
- **RESOLVED** — Runtime: Node.js + Express confirmed.
- **RESOLVED** — Transport: LAN-only HTTP REST. No cloud dependency.
- **RESOLVED** — Data store: SQLite roster DB plus event-scoped JSON for ring state. Group data is reconstructed from SQLite after restart.

---

## 9 — Component Checklist

**Legend:** `[x]` Complete / confirmed · `[~]` In Progress · `[ ]` Not Started
**Sub-task `[x]`** = confirmed from prior code review.

### Server Bootstrap (`group-server.js`)

- [~] Express app setup and middleware
  - [x] `group-server.js` exists and starts an HTTP server
  - [x] JSON body parser middleware configured
  - [ ] CORS headers configured for tablet client access
  - [x] Route modules mounted under `/api/`
  - [ ] Static file serving for admin web UI confirmed working
  - [ ] Graceful shutdown handler (SIGTERM/SIGINT)

### Persistence Layer (`competitorStore.js`, `groupStore.js`)

- [~] Core data store implementation
  - [x] `competitorStore.js` exists and reads from SQLite
  - [x] `groupStore.js` caches event groups in memory for dynamic ring downloads
  - [x] Ring state persists to event-scoped JSON
  - [x] Competitor, Division, Group, Ring entities defined
  - [x] Ring `assistanceType`, `assistanceRequestedAt`, `assignmentStartedAt`, and heartbeat fields confirmed on ring objects
  - [x] SQLite indexes exist for search fields and group-division lookup

### Division & Group Management (`divisionRoutes.js`)

- [~] Group operations
  - [x] `GET /api/groups` - list all groups
  - [x] `GET /api/groups/:groupId` - get group with competitor list
  - [x] `POST /api/divisions/build` - trigger group builder and assign division numbers starting at 20
  - [x] `POST /api/divisions/save` - persist normalized groups and write group + discipline division numbers back to SQLite

### Ring Operations (`ringRoutes.js`)

- [~] Ring state and phase management
  - [x] `GET /api/rings/config` - ring selection config required by Android app
  - [x] `POST /api/rings/config` - ring count/config update
  - [x] `GET /api/rings` - ring board summary used by head table
  - [x] `GET /api/rings/:ringId/bootstrap` - current assignment load required by Android app
  - [x] `POST /api/rings/:ringId/request-group` - current assignment load required by Android app
  - [x] `GET /api/rings/:ringId/current` - ring-state sync
  - [x] `POST /api/rings/:ringId/queue` - queue a group on a ring
  - [x] `DELETE /api/rings/:ringId/queue/:groupId` - remove a queued group
  - [x] `POST /api/rings/:ringId/heartbeat` - client keepalive with phase progress
  - [x] `POST /api/rings/:ringId/complete` - mark group complete and advance
  - [x] `POST /api/rings/:ringId/reset` - clear ring to scratch
  - [x] `POST /api/rings/:ringId/assistance` - assistance request endpoint
  - [x] `POST /api/rings/:ringId/assistance/clear` - clear assistance endpoint

### Group Builder (`groupBuilder.js`)

- [~] Group building algorithm
  - [x] `groupBuilder.js` exists
  - [x] Point-sparring bracket/round-robin logic confirmed
  - [ ] Flag-sparring group logic confirmed
  - [ ] Forms/kata group logic confirmed
  - [x] Bye handling for odd-numbered competitor lists
  - [x] Group and competition division numbers are assigned sequentially from 20

### Admin Web UI

- [~] Head table interface
  - [x] Competitor import (CSV) working end-to-end
  - [x] Division configuration UI
  - [x] Group build trigger UI
  - [x] Ring assignment UI
  - [x] Ring status monitor (all rings at a glance)
  - [x] Assistance acknowledgement UI
  - [x] Queue management and ring progress display

### Testing & Quality

- [ ] Unit tests
  - [ ] `competitorStore.js` - CRUD operations
  - [ ] `groupBuilder.js` - group building with even/odd competitor counts
  - [ ] Route handlers - mock store, verify response shapes
- [ ] Integration tests
  - [ ] End-to-end: create division -> add competitors -> build groups -> assign to ring -> simulate check-in and score submission
- [ ] Load test
  - [ ] Simulate 10 concurrent tablet clients maintaining heartbeat traffic at 60-second intervals

---

## 10 — Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-18 | Scott | Initial server-side HLD. All sections drafted; checklist items reflect confirmed state from prior code review sessions. |
| 0.2 | 2026-09-22 | Copilot | Updated for SQLite/event-file persistence, current ring routes, assignment timers, and head-table/ring-assignment UI revisions. |

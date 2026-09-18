# Tournament Management System — Server-Side High-Level Design

| Field | Value |
|---|---|
| Document Type | High-Level Design (HLD) |
| Status | Draft |
| Version | 0.1 |
| Date | 18 September 2026 |
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

All checklist items in Section 9 begin as **Not Started (☐)** unless explicitly marked with ✅ (confirmed from prior code review) or 🔄 (in progress).

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
- **Persistence:** In-memory store (`competitorStore.js`) — no external database. Data is lost on server restart unless explicitly exported.
- **Transport:** HTTP REST (JSON). No WebSocket or SSE implemented yet — see Section 8.
- **Entry point:** `group-server.js`

---

## 3 — Module Architecture

The server is organized into a main entry point and a `backend/` directory containing route handlers and shared data stores.

```
tournament-server/
├── group-server.js          # Entry point — Express app setup, static files, route mounting
├── backend/
│   ├── competitorStore.js   # In-memory data store for all tournament entities
│   ├── divisionRoutes.js    # Routes: division and group management
│   ├── ringRoutes.js        # Routes: ring state, check-in, scoring, alerts
│   └── groupBuilder.js      # Logic: builds match groups from competitor lists
└── docs/
    └── HLD-server.md        # This document
```

### 3.1 — `group-server.js` (Entry Point)

Bootstraps the Express application. Responsibilities:

- Initializes the Express app and configures middleware (JSON body parser, CORS, static file serving).
- Mounts route modules: `divisionRoutes` and `ringRoutes` under `/api/`.
- Serves the admin web UI as static HTML/JS files from a `public/` or `client/` directory.
- Starts the HTTP server on the configured port (default: `3000`).

### 3.2 — `competitorStore.js` (In-Memory Data Store)

The central data store for the entire system. Holds all mutable state in memory:

- **Competitors** — all registered competitors for the event.
- **Divisions** — logical groupings of competitors by age, gender, belt rank, and event type.
- **Groups** — competition groups built from divisions, assigned to rings.
- **Rings** — physical competition areas with their current state (phase, assigned group, queue, alerts).
- **Match Results** — scored outcomes for completed matches.

Exported as a shared module so all route handlers read from and write to the same in-memory state.

### 3.3 — `divisionRoutes.js` (Division & Group Routes)

Handles all operations related to divisions and group management. Key routes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/divisions` | List all divisions |
| `POST` | `/api/divisions` | Create a new division |
| `GET` | `/api/divisions/:divisionId` | Get a single division |
| `PUT` | `/api/divisions/:divisionId` | Update division details |
| `POST` | `/api/divisions/:divisionId/competitors` | Add a competitor to a division |
| `GET` | `/api/groups` | List all groups |
| `POST` | `/api/groups/build` | Trigger group building for a division |
| `GET` | `/api/groups/:groupId` | Get a group with its competitor list |
| `POST` | `/api/groups/:groupId/assign` | Assign a group to a ring |

### 3.4 — `ringRoutes.js` (Ring Operation Routes)

Handles all live-event operations for rings — the primary interface for the Android tablet clients. The Android app already depends on the config, bootstrap, heartbeat, completion, and assistance endpoints below, so they are part of the intended server contract even if some remain unimplemented.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rings/config` | Return ring options available to a tablet client |
| `GET` | `/api/rings` | List all rings and their current state |
| `GET` | `/api/rings/:ringId` | Get a single ring's full state |
| `POST` | `/api/rings/:ringId/heartbeat` | Record periodic client contact and current ring phase |
| `POST` | `/api/rings/:ringId/bootstrap` | Load the current group and ring assignment for a tablet |
| `POST` | `/api/rings/:ringId/phase` | Advance the ring phase (scheduled → in progress → complete) |
| `POST` | `/api/rings/:ringId/complete` | Mark the current group complete |
| `POST` | `/api/rings/:ringId/checkin` | Submit competitor check-in status |
| `POST` | `/api/rings/:ringId/score` | Submit a match score/outcome |
| `POST` | `/api/rings/:ringId/assistance` | Request assistance from the head table |
| `POST` | `/api/rings/:ringId/assistance/clear` | Clear an active assistance request |
| `POST` | `/api/rings/:ringId/alert` | Send an assistance alert from a ring volunteer |
| `GET` | `/api/rings/:ringId/announcements` | Fetch head table announcements for a ring |
| `POST` | `/api/rings/:ringId/announce` | Broadcast an announcement from head table to a ring |

### 3.5 — `groupBuilder.js` (Group Building Logic)

Contains the algorithm that takes a division's competitor list and produces ordered match groups. Responsibilities:

- Accept a list of competitors and a scoring mode (e.g., point sparring, flag sparring, forms).
- Apply seeding, randomization, or bracket logic to produce a match schedule.
- Return an ordered list of groups ready to be assigned to rings.

---

## 4 — Data Model

All data is held in memory in `competitorStore.js`. There is no schema enforcement — these are the de facto shapes used throughout the system.

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
assignedRingId     string | null
status             string    "unassigned" | "queued" | "in-progress" | "complete"
```

### Ring

```
ringId             string    Unique identifier
ringLabel          string    e.g. "Ring 1"
phase              string    "idle" | "scheduled" | "in-progress" | "complete"
currentGroupId     string | null
currentGroupName   string | null
queue              Group[]   Upcoming groups assigned to this ring
assistanceType     string | null   "dispute" | "medical" | "division-complete" | "other"
assistanceRequestedAt  string | null   ISO timestamp
announcements      Announcement[]
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
- Send announcements to specific rings
- Dismiss alerts from ring volunteers

---

## 7 — Non-Functional Requirements

| Requirement | Target |
|---|---|
| **Availability** | Must run fully offline on venue LAN. No internet dependency. |
| **Performance** | API responses must complete within 200ms on a local LAN under normal load (≤ 10 tablet clients). |
| **Persistence** | In-memory only. Data is lost on server restart. Export/backup mechanism is an open question (see Section 8). |
| **Scalability** | Designed for single-venue, single-event use. No multi-event or multi-venue support required. |
| **Compatibility** | Runs on Node.js LTS. No OS-specific dependencies. Should run on Windows laptop available at venue. |
| **Security** | No authentication currently. Physical access control assumed. See Section 8. |
| **Recoverability** | If the server restarts during an event, ring state is lost. Volunteers must reconnect and head table must manually restore active ring assignments. This is a known risk — see Section 8. |

---

## 8 — Open Questions & Decisions

- **OPEN** — **Real-time updates:** The Android app currently uses `/api/rings/config` to discover allowed rings and sends periodic heartbeats to `/api/rings/:ringId/heartbeat` on screen/ring change and every 60 seconds while assigned. WebSocket or SSE support on the server would still be a design option for push notifications. Decision pending.
- **OPEN** — **Data persistence:** All data is in-memory. A crash or restart during an event loses all state. Options: periodic JSON export to disk, SQLite, or a simple file-based store. Decision pending.
- **OPEN** — **Authentication:** No login or role enforcement. All clients on the LAN can call any API endpoint. Future hardening may require an API key or session token. Decision pending.
- **OPEN** — **Competitor import format:** Manual entry and CSV import are referenced but the exact CSV schema is not finalized.
- **OPEN** — **Scoring mode support:** Point sparring is the primary confirmed mode. Flag sparring and forms/kata scoring logic in `groupBuilder.js` may be incomplete.
- **OPEN** — **Export/backup:** No mechanism to export results at end of event. Needed for record-keeping.
- **RESOLVED** — Runtime: Node.js + Express confirmed.
- **RESOLVED** — Transport: LAN-only HTTP REST. No cloud dependency.
- **RESOLVED** — Data store: In-memory (`competitorStore.js`). Server is source of truth.

---

## 9 — Component Checklist

**Legend:** ✅ Complete · 🔄 In Progress · ☐ Not Started
**Sub-task ✅** = confirmed from prior code review.

### Server Bootstrap (`group-server.js`)

- 🔄 Express app setup and middleware
  - ✅ `group-server.js` exists and starts an HTTP server
  - ✅ JSON body parser middleware configured
  - ☐ CORS headers configured for tablet client access
  - ✅ Route modules mounted under `/api/`
  - ☐ Static file serving for admin web UI confirmed working
  - ☐ Graceful shutdown handler (SIGTERM/SIGINT)

### In-Memory Data Store (`competitorStore.js`)

- 🔄 Core data store implementation
  - ✅ `competitorStore.js` exists and is imported by route modules
  - ✅ Competitor, Division, Group, Ring entities defined
  - ☐ Ring `assistanceType` and `assistanceRequestedAt` fields confirmed on all ring objects
  - ☐ Announcements array on Ring entity confirmed
  - ☐ MatchResult structure confirmed

### Division & Group Management (`divisionRoutes.js`)

- ☐ Division CRUD operations
  - ☐ `GET /api/divisions` — list all divisions
  - ☐ `POST /api/divisions` — create division
  - ☐ `PUT /api/divisions/:divisionId` — update division
  - ☐ `POST /api/divisions/:divisionId/competitors` — enroll competitor
- ☐ Group operations
  - ☐ `GET /api/groups` — list all groups
  - ☐ `GET /api/groups/:groupId` — get group with competitor list
  - ☐ `POST /api/groups/build` — trigger group builder
  - ☐ `POST /api/groups/:groupId/assign` — assign group to ring

### Ring Operations (`ringRoutes.js`)

- 🔄 Ring state and phase management
  - ✅ `GET /api/rings` — confirmed working (used by Android app ring selection)
  - ✅ `GET /api/rings/:ringId` — confirmed working (used by Android app ring-state sync)
  - ☐ `GET /api/rings/config` — ring selection config required by Android app
  - ☐ `POST /api/rings/:ringId/heartbeat` — client keepalive required by Android app
  - ☐ `POST /api/rings/:ringId/bootstrap` — current assignment load required by Android app
  - ✅ Ring phase field (`scheduled` / `in-progress` / `complete`) confirmed on ring object
  - ☐ `POST /api/rings/:ringId/phase` — advance phase endpoint
  - ☐ `POST /api/rings/:ringId/complete` — mark group complete endpoint
  - ☐ `POST /api/rings/:ringId/checkin` — check-in submission endpoint
  - ☐ `POST /api/rings/:ringId/score` — score submission endpoint
  - ☐ `POST /api/rings/:ringId/assistance` — assistance request endpoint
  - ☐ `POST /api/rings/:ringId/assistance/clear` — clear assistance endpoint
  - ✅ `POST /api/rings/:ringId/alert` — assistance alert endpoint (assistanceType confirmed)
  - ☐ `GET /api/rings/:ringId/announcements` — announcement retrieval endpoint
  - ☐ `POST /api/rings/:ringId/announce` — head table broadcast endpoint

### Group Builder (`groupBuilder.js`)

- ☐ Group building algorithm
  - ✅ `groupBuilder.js` exists
  - ☐ Point-sparring bracket/round-robin logic confirmed complete
  - ☐ Flag-sparring group logic confirmed
  - ☐ Forms/kata group logic confirmed
  - ☐ Bye handling for odd-numbered competitor lists

### Admin Web UI

- ☐ Head table interface
  - ☐ Competitor import (CSV) working end-to-end
  - ☐ Division configuration UI
  - ☐ Group build trigger UI
  - ☐ Ring assignment UI
  - ☐ Ring status monitor (all rings at a glance)
  - ☐ Alert acknowledgement UI
  - ☐ Announcement broadcast UI

### Testing & Quality

- ☐ Unit tests
  - ☐ `competitorStore.js` — CRUD operations
  - ☐ `groupBuilder.js` — group building with even/odd competitor counts
  - ☐ Route handlers — mock store, verify response shapes
- ☐ Integration tests
  - ☐ End-to-end: create division → add competitors → build groups → assign to ring → simulate check-in and score submission
- ☐ Load test
  - ☐ Simulate 10 concurrent tablet clients maintaining heartbeat traffic at 60-second intervals

---

## 10 — Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-18 | Scott | Initial server-side HLD. All sections drafted; checklist items reflect confirmed state from prior code review sessions. |

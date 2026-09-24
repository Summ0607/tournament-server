# Tournament Management System — Server-Side High-Level Design

| Field | Value |
|---|---|
| Document Type | High-Level Design (HLD) |
| Status | Draft |
| Version | 0.3 |
| Date | 24 September 2026 |
| Author | Scott |
| Runtime | Node.js + Express |
| Entry Point | `group-server.js` |
| Companion | Tournament Scoring App — High-Level Design (Android Client) |
| Audience | Developers, Collaborators, Technical Stakeholders |

---

## 1 — Purpose and Scope

This document describes the server component of the Tournament Management System: a Node.js/Express application that runs on the venue LAN and supports tournament setup, event selection, roster import, grouping, ring operations, head-table monitoring, and receipt of completed ring result packets.

It is the companion to the Android client HLD. This document records behavior verified from the supplied server source and identifies gaps between server and Android client contracts that should be resolved before live-event deployment.

### Scope boundary

This HLD covers server-side routes, data ownership, persistence, static web UI hosting, and the server-facing integration contract. It does not describe Android UI implementation in detail.

### Status terms

- **Implemented/confirmed:** directly evidenced in the reviewed server source.
- **Partially integrated:** server support exists, but the Android caller or complete workflow is not evidenced in the reviewed client source.
- **Planned:** desired functionality not fully implemented or not fully verified.

---

## 2 — System Overview

The tournament server is a Node.js/Express application hosted locally on a tournament laptop or other venue machine. It listens on port 3000, accepts JSON payloads up to 50 MB, exposes permissive CORS headers, and serves both REST APIs and browser-based administration pages. It is designed for LAN-only operation and does not depend on cloud services or internet connectivity.

The server serves three principal audiences:

| Audience | Primary responsibility |
|---|---|
| Head-table staff | Create/select/reset events, import rosters, build and save groups, configure rings, queue groups, monitor progress, and respond to assistance requests |
| Android ring tablets | Discover/select a ring, request or restore a group assignment, send heartbeat/progress updates, and eventually submit a final division packet |
| Browser/admin tools | Use static pages for setup, group building, ring assignment, ring progress, dashboard/head-table operations, and status viewing |

### Architectural roles

- **SQLite** stores imported competitor roster data and persisted group/division assignments.
- **Event directories** separate event databases, groups, results, and ring-assignment state.
- **In-memory group cache** serves the currently active event’s saved groups after they are loaded from SQLite.
- **Event JSON files** retain active-event selection and per-event ring-assignment state.
- **Results JSON files** retain uploaded division/ring result packets.
- **Trace logs** record group-division and heartbeat/ring-progress diagnostics.

The server is authoritative for roster, assigned group/ring state, event state, and uploaded result history. The Android app currently performs local operational scoring and communicates ring status/progress to the server.

---

## 3 — Modules and Persistence

### Server modules

| Module | Confirmed responsibility |
|---|---|
| `group-server.js` | Express bootstrap, CORS/JSON middleware, event lifecycle routes, health/version/APK routes, CSV import, competitor search, route mounting, active-event handling, state helpers, and result-packet persistence |
| `db/init.js` | Creates/migrates the SQLite `competitors` table and indexes |
| `db/import-csv.js` | Imports roster CSV rows, normalizes fields, calculates age, and identifies weapons eligibility |
| `backend/competitorStore.js` | Reads competitors and transactionally saves group/division assignments back to SQLite |
| `backend/groupBuilder.js` | Builds age/rank/gender-oriented tournament groups and assigns division numbers |
| `backend/groupStore.js` | In-memory cache for groups in the active event context |
| `backend/divisionRoutes.js` | Lists, builds, and saves groups/divisions |
| `backend/ringRoutes.js` | Ring configuration, assignment, queueing, heartbeat/progress, completion, reset, and assistance endpoints |
| `backend/pages.js` | Static browser routes and redirects for setup, group builder, ring assignment/progress, dashboard, head table, and status pages |
| `backend/groupDivisionAssignments.js` | Sequential group/competition division numbering and division trace logging |

### Event directory model

The code supports an active event selected through `events/active.json`. For an event name, the server expects or creates:

```text
events/<eventName>/
├── tournament.db
├── groups/
├── results/
└── ring-assignments.json
```

When no active event is selected, the server falls back to its root/default database and group/ring locations. This fallback is useful for development but should be treated carefully in operations because event isolation depends on correctly selecting an event.

### SQLite competitor data

The verified `competitors` table includes identity/contact/import fields plus tournament fields:

```text
id                          INTEGER primary key
firstName, lastName         TEXT
parentFirstName, parentLastName, email, phone, dob
associationNumber           TEXT
gender, rank, studio        TEXT
specialNeeds                INTEGER
height                      INTEGER
weaponsDivision             TEXT; default unassigned
hyungsDivision              TEXT; default unassigned
sparringDivision            TEXT; default unassigned
ringAssignment              TEXT; default unassigned
groupDivisionId             TEXT
groupDivisionName           TEXT
groupDivisionNumber         INTEGER
competitionDivisionNumber   INTEGER
```

Indexes are maintained for first name, last name, association number, rank, group division number, and group division ID.

### Ring state

A ring state records the current group, queued/completed groups, assignment timestamp, check-in and phase progress counters, assistance state, tablet identity, heartbeat time, phase start time, and phase. Supported phases are `idle`, `check-in`, `weapons`, `hyungs`, `sparring`, and `awards`; ring responses expose a normalized phase plan that uses `setup` as the display key for check-in.

### Result history

`POST /api/rings/:ringId/complete` invokes `saveUploadedDivisionPacket(ringId, req.body)`. The packet is saved as JSON in the current results directory using a sanitized `divisionId`, `groupId`, or ring ID as the filename basis. This is the implemented foundation for durable ring-result history.

Current limitations:

- The server stores the supplied packet without a formal schema/version validation.
- The result filename can collide if the same division/group identifier is submitted again, replacing the existing file.
- The server code supplied does not expose a results-listing or results-retrieval API.
- The reviewed Android networking code does not yet expose a completion/packet-upload caller.

---

## 4 — API Contract

All APIs are under `/api`. Requests and responses are JSON unless a route serves an APK download.

### Health, version, app distribution, and events

| Method | Path | Implemented behavior |
|---|---|---|
| GET | `/api/health` | Returns `{ ok: true, message: "Group server is running" }` |
| GET | `/api/version` | Reads Android Gradle metadata when present and returns `versionCode` and `versionName`; returns zero values if unavailable |
| GET | `/download-app` | Serves `app-debug.apk` as an Android package download when present |
| GET | `/api/events/list` | Lists event directories |
| GET | `/api/events/active` | Returns the active event name |
| POST | `/api/events/create` | Creates an event directory, SQLite database, groups/results directories, and initial ring-assignment file |
| POST | `/api/events/activate` | Selects an existing event and primes group cache from its database |
| POST | `/api/events/reset` | Deletes/recreates the selected event’s database, groups, results, and ring state |
| POST | `/api/events/import-csv` | Imports a CSV from a server path or uploaded text into the selected/active event database |

### Competitors and group/division management

| Method | Path | Implemented behavior |
|---|---|---|
| GET | `/api/competitors` | Returns competitors from the active-event database |
| GET | `/api/competitors/table` | Returns database rows plus header names |
| GET | `/api/search` | Searches competitors by first name, last name, association number, group division number, or rank |
| GET | `/api/groups` | Returns groups from the active in-memory group store |
| GET | `/api/groups/:groupId` | Returns one cached group or 404 |
| POST | `/api/divisions/build` | Builds groups from payload competitors or active-event database roster; explicit groups may also be numbered/returned |
| POST | `/api/divisions/save` | Assigns sequential division numbers, writes assignments to SQLite transactionally, saves groups in cache, and emits a trace entry |

### Ring operations

| Method | Path | Implemented behavior |
|---|---|---|
| GET | `/api/rings/config` | Returns rings allowed/available for a tablet; accepts optional `tabletLabel` |
| POST | `/api/rings/config` | Sets letter/number ring configuration and regenerates ring states |
| GET | `/api/rings` | Returns current ring board/state summary |
| GET | `/api/rings/:ringId/bootstrap` | Retrieves existing ring assignment/state without forcing group advancement |
| POST | `/api/rings/:ringId/request-group` | Associates tablet/progress information and, when idle with queued work, advances the next queued group into current assignment |
| GET | `/api/rings/:ringId/current` | Retrieves ring state/current assignment |
| POST | `/api/rings/:ringId/queue` | Adds an existing group to a ring queue; prevents duplicate cross-ring use |
| DELETE | `/api/rings/:ringId/queue/:groupId` | Removes a group from a ring queue |
| POST | `/api/rings/:ringId/heartbeat` | Updates tablet label, phase, check-in counts, active-phase counts, and progress; writes heartbeat trace |
| POST | `/api/rings/:ringId/complete` | Saves posted result packet, marks current group complete, activates next queued group if any, and returns updated state |
| POST | `/api/rings/:ringId/reset` | Clears one ring to scratch state |
| POST | `/api/rings/reset` | Resets all ring assignments to configured empty rings |
| POST | `/api/rings/:ringId/assistance` | Records an assistance type and timestamp |
| POST | `/api/rings/:ringId/assistance/clear` | Clears the active assistance request |

### Ring request/response semantics

`request-group` and `heartbeat` recognize these request fields when present:

```json
{
  "tabletLabel": "manufacturer model",
  "phase": "check-in | weapons | hyungs | sparring | awards",
  "checkInCount": 0,
  "checkInTotal": 0,
  "phaseCompletedCount": 0,
  "phaseTotalCount": 0,
  "phaseProgress": 0
}
```

For compatibility, the server also recognizes `checkedInCount`, `completedCount`, `totalCount`, and `progress` aliases in relevant paths. Progress values in the range 0–1 are converted to percentages; other values are bounded to 0–100.

A ring response includes identity, server base URL, event start time, current/queued/completed group IDs, assignment and phase metadata, assistance status, tablet/heartbeat information, current group data, and computed `phasePlan` details.

### Phase-plan behavior

The server exposes the visible phases in the order Setup, Weapons when eligible competitors exist, Hyungs, Sparring, and Awards. Internally, the server maps the Android/client value `check-in` to the UI plan key `setup`. A weapon phase is shown if any member has `weaponsEligible` true or has a non-`unassigned` `weaponsDivision`.

---

## 5 — Grouping, Eligibility, and Workflow

### Roster import and normalization

CSV import maps human-readable headers such as First Name, Last Name, DOB, Association Number, Gender, Current Rank, Studio, Special Needs, and Height. It normalizes gender, uppercases rank, derives age from DOB where possible, supplies a competitor ID when none exists, and identifies server-side weapons eligibility.

### Group building

The group builder is oriented around tournament-operational groups, not individual event-type brackets. It:

- Treats TTLD as a dedicated grouping category.
- Separates or groups competitors using gender, rank bands, and age buckets.
- Uses a default target range of four to six competitors unless parameters override it.
- Handles TTLD groups specially, splitting by gender only when both male and female counts reach four.
- Assigns sequential `groupDivisionNumber` values, defaulting to a starting value of 20.
- Assigns sequential `competitionDivisionNumber` values within/after groups.

When groups are saved, every group member receives hyungs and sparring division values based on the group division number. Weapons division is assigned only to server-eligible ranks.

### Live ring workflow

1. Head-table staff create or activate an event and import competitors.
2. Staff build/review/save groups, thereby persisting group and division assignments.
3. Staff configure rings and queue groups to rings.
4. A tablet retrieves available ring configuration and posts to `request-group` for a selected ring.
5. The server activates the next queued group where appropriate and returns group/ring/phase state.
6. The tablet sends heartbeats as the ring progresses through check-in, weapons where applicable, hyungs, sparring, and awards.
7. The tablet posts a final result packet to `complete`; the server saves the packet and advances the queue.
8. Head-table staff monitor ring status, progress, assistance, and later event-result history.

Steps 1–6 are server-supported and partially client-supported in the reviewed Android code. Step 7 is server-supported but requires Android client completion-upload integration and a formal result-packet contract.

---

## 6 — Client/Server Inconsistencies

The following issues need an explicit decision and should not be treated as merely documentation differences.

### 6.1 Rank vocabulary mismatch — high priority

The server stores/normalizes ranks as `TTLD`, `G10` through `G1`, `CDB`, and `D1` through `D3`. The Android engine’s form catalog and rank parser use labels such as `10th Gup` through `1st Gup`, `Cho Dan Bo`, `Cho Dan`, `E Dan`, and `Sam Dan`.

The Android remote parser passes the server’s `rank` value directly into the app’s rank-level/form logic. Without a shared rank-normalization contract, values such as `G2`, `CDB`, and `D1` can be unrecognized on the Android side, causing invalid rank levels, incorrect range labels, and failures when requesting allowed forms.

**Required resolution:** establish one canonical wire format or implement bidirectional normalization at the API boundary. Recommended wire values are the server’s compact codes, with one shared mapping on Android and server/admin UI.

### 6.2 Weapons eligibility mismatch — high priority

Server import and assignment logic grant weapons eligibility only to `G2`, `G1`, `CDB`, `D1`, `D2`, and `D3`, which corresponds to 2nd Gup and above. The Android form catalog offers a weapons form beginning at 4th Gup and allows 4th and 3rd Gup competitors to enter weapons.

This produces a direct operational disagreement: the server may omit the Weapons phase for a group containing 4th/3rd Gup competitors, while the Android app considers them eligible.

**Required resolution:** decide the governing tournament rule, then update both the server eligibility set and Android catalog/tests together.

### 6.3 Missing rank/eligibility fields in Android remote model — high priority

Server groups carry discipline fields such as `weaponsEligible`, `weaponsDivision`, `hyungsDivision`, and `sparringDivision`. The Android `RemoteCompetitor` model only retains ID, name, studio, rank, age, and height. When converted to local competitors, it initializes an empty competition-entry map.

Consequently, the Android app cannot use server-assigned discipline enrollment as authoritative input. It instead relies on client-derived eligibility and local registration state.

**Required resolution:** extend the Android wire model and parser to preserve server eligibility/division fields, then initialize `CompetitionEntry` values from those fields; or formally declare the client as the eligibility authority and simplify server fields accordingly.

### 6.4 Group payload metadata gap — medium priority

The Android client supports group age range, rank range, rank range label, and `matNumber`. The server’s cached group shape shown in source carries group ID/name/division number and competitor data, but does not reliably emit `ageRange`, `rankRange`, `rankRangeLabel`, or `matNumber`.

Android handles these absences with defaults or derives rank range from competitor ranks, but default age range `0..0` and mat number `1` are not meaningful operational metadata.

**Required resolution:** either have the server emit explicit group metadata or have Android intentionally derive/display it rather than represent it as server-provided.

### 6.5 Phase nomenclature mismatch — medium priority

The Android heartbeat maps its check-in screen to `check-in`. The server stores `check-in` but exposes `setup` in `phasePlan.currentPhase`. Android currently parses `currentPhase` as a raw string and serializes `phasePlan` to a string rather than a typed structure.

**Required resolution:** choose a single wire phase vocabulary. The lowest-impact option is to retain `check-in` in all API fields and use “Setup” only as a presentation label.

### 6.6 Result-history workflow is only half connected — high priority

The server does implement packet receipt on `POST /api/rings/:ringId/complete` and writes JSON under event results. The reviewed Android repository/view-model exposes no `complete` method and no result-packet upload function.

**Required resolution:** define a versioned division-result packet, add Android upload/retry/acknowledgement behavior, and add server validation plus result retrieval/export routes.

### 6.7 Version/update route mismatch — medium priority

The Android client checks `GET /api/version` and has a helper to install a local APK. The server provides `GET /api/version` and serves the APK from `/download-app`. The Android code reviewed does not contain a downloader or a call to `/download-app`.

**Required resolution:** retain the update feature and add download/verification/install UX, or remove/update the HLD references if APK distribution will be manual or managed externally.

### 6.8 Heartbeat cadence statement is not code-confirmed — medium priority

The server supports heartbeats and keeps disconnection policy disabled; it does not automatically reclaim a ring after 90 seconds. The earlier HLD describes a 60-second tablet cadence, but the reviewed Android source includes the heartbeat function without the omitted UI/scheduler implementation.

**Required resolution:** document the actual cadence only after verifying the Compose caller, and decide whether the 90-second constant should become an active stale-client policy or be removed.

### 6.9 Result persistence path naming requires clarification — low priority

The server has an event-specific `results/` directory in event lifecycle code and a root `Results/` constant used by packet saving in the supplied entry point excerpt. Confirm that packet saving resolves to the active event’s result directory; otherwise result history may escape event isolation.

### 6.10 HTTP status handling mismatch — low priority

The Android generic JSON client currently treats only HTTP 200 as a successful JSON response. Express routes may validly return other 2xx statuses as the API evolves. The health probe accepts all 2xx responses, but generic data calls do not.

**Required resolution:** make Android generic JSON handling accept the 200–299 range or standardize all server JSON success responses to 200.

---

## 7 — Non-Functional Characteristics

### Availability and recovery

- LAN-only HTTP operation is intentional.
- Ring state and event metadata are stored on disk as JSON.
- Competitors and saved division assignments are persisted in SQLite.
- On event activation, the server primes the active group cache from the active event’s database.
- Tablet reconnects can recover server-side ring assignment via bootstrap/current/request-group endpoints.
- Current heartbeat policy intentionally does not auto-release disconnected rings; an operator must reset a ring manually.

### Observability

- Group build/save, queue activation, and related division activity are written to `group-division-trace.log`.
- Heartbeat snapshots are written to `ring-progress-trace.log`.
- Server errors are written to standard console output.

### Security

- No authentication or authorization is implemented.
- CORS allows all origins.
- HTTP is unencrypted.
- The operating assumption is a controlled private venue LAN and physical operator access.

Before use on an untrusted network, introduce authentication, access restrictions, HTTPS or an equivalent protected network posture, and input validation/auditing appropriate to personally identifiable roster data.

### Performance and scale

The implementation is designed for a single venue and one active event at a time. SQLite and local JSON storage are appropriate for the expected small number of rings/tablets, but load, restart, and multi-tablet conflict testing should be completed before operational reliance.

---

## 8 — Implementation Checklist

Legend: ✅ confirmed in reviewed source; 🔄 partially integrated or needs end-to-end verification; ☐ planned or not verified.

### Bootstrap and event lifecycle

- ✅ Express server on port 3000
- ✅ JSON body parsing with 50 MB limit
- ✅ Permissive CORS middleware
- ✅ Health endpoint
- ✅ Version endpoint derived from Android Gradle metadata when available
- ✅ APK file serving endpoint
- ✅ Event create, list, activate, active-event query, and reset routes
- ✅ Event-specific database/groups/results/ring-state directory creation
- 🔄 Verify active-event results persistence consistently uses event-specific directory

### Roster and group management

- ✅ SQLite schema migration and indexes
- ✅ CSV roster import with normalization, age derivation, and weapons eligibility calculation
- ✅ Competitor retrieval/table/search endpoints
- ✅ Group build and explicit-group numbering
- ✅ Transactional persistence of group/competition division numbers
- ✅ In-memory group cache for active event
- ✅ Group division trace logging
- 🔄 Verify all group-cache behavior after server restart and event activation

### Ring operations

- ✅ Ring count/configuration and label generation
- ✅ Ring queue management with cross-ring duplicate prevention
- ✅ Bootstrap/current/request-group endpoints
- ✅ Current group activation from queue
- ✅ Ring phase and progress tracking
- ✅ Heartbeat recording and trace logging
- ✅ Assistance request and clear endpoints
- ✅ Ring completion advances queue and persists submitted packet
- ✅ Individual and global ring reset routes
- 🔄 Confirm dashboard/admin pages exercise every intended endpoint
- ☐ Formal stale-client/reclaim policy

### Result history

- ✅ Server receives and writes a result packet during ring completion
- ☐ Versioned JSON schema for result packet
- ☐ Server-side packet validation and duplicate/idempotency behavior
- ☐ Result retrieval/listing/export APIs and head-table history UI
- ☐ Android final-result upload, acknowledgement, retry, and reconciliation
- ☐ End-of-event archive/export/backup procedure

### Cross-client contract

- ☐ Canonical rank-code mapping shared by server and Android client
- ☐ Harmonized weapons eligibility rule
- ☐ Server discipline assignments preserved by Android parser/model
- ☐ Explicit group metadata contract for age/rank ranges and mat/ring number
- ☐ Unified wire vocabulary for check-in/setup phase
- ☐ Typed phase-plan parsing on Android where the UI needs it
- ☐ Confirmed heartbeat interval and disconnect policy

### Testing and operations

- ☐ Unit tests for rank mapping, eligibility, CSV normalization, group building, packet validation, and ring progression
- ☐ Route tests for normal, invalid, duplicate, and concurrent requests
- ☐ Android/server contract tests using captured JSON fixtures
- ☐ Multi-tablet LAN integration test including reconnect, queue progression, assistance, and result upload
- ☐ Backup/restore rehearsal for a completed event

---

## 9 — Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.3 | 24 September 2026 | Scott | Rewritten from current server and Android source review. Adds event lifecycle, confirmed result-packet receipt/persistence, concrete route contract, group/SQLite behavior, trace logging, and a cross-client inconsistency register. |
| 0.2 | 22 September 2026 | Copilot | Updated for SQLite/event-file persistence, ring routes, assignment timers, and head-table/ring-assignment UI revisions. |
| 0.1 | 18 September 2026 | Scott | Initial server-side HLD. |

# tournament-server
Tournament Management Server Source

## Prediction/estimation checkpoint: 2026-10-25

Branch `feature/prediction-estimation` builds on the tooltip/UI cleanup
checkpoint and includes the shared estimation engine, active-event APIs,
Ring Assignment tile estimates, Head Table planning windows, freshness guards,
page help, and stable success feedback documented below.

This checkpoint does not implement Audience Monitor or Competitor/Volunteer
Lookup screens. Their next development branch, `feature/audience-monitor-lookup`,
starts from this checkpoint so it retains the shared estimation support and
reviewed day-of UI. No merge into `feature/tournament-day-of` is included.

Validation: `npm test` (including estimation, integrated UI, help, and ring
contracts) and `git diff --check`. Browser checks covered compact tile layout,
visible start/duration text, next-day dates, stale-start replacement, page help,
and removal of division hover summaries using read-only fixtures.

## Ring planning estimates

Branch `feature/prediction-estimation` adds shared active-event forecasts to
the integrated Ring Assignment and Head Table pages. Restart the server and
refresh the browser to load the backend and UI together. No new dependencies,
automatic assignments, ring resets, or saved-data migrations are required.

- Select a ring for its current division's approximate completion, ordered
  queued-division start windows, and availability after its existing queue.
- Available division tiles show one additional line, for example
  `Start ~10:40 AM · Ring ~42 min`, without a hover summary.
  The start assumes the earliest projected available ring. Suggestions are independent:
  they do not reserve capacity, reorder the queue, or promise a call time.
  If a start cannot be predicted, `Start TBD` is shown; a valid saved-roster
  duration remains visible. Missing duration data explicitly shows `Ring time TBD`.
- A compact summary identifies the earliest projected ring availability.
  Existing compact cards, phase pills, connection indicators and assistance
  actions are preserved. Each page's **?** explains the model and limitations.
- Ring Assignment confirms successful queue, removal, reset, and layout actions
  through the updated ring/queue state, without transient success banners that
  shift the board. Errors, validation warnings, and destructive confirmations
  remain explicit.
- Empty configured rings without connected tablets contribute **planning-only**
  availability, assuming staffing/connection before use. Their connection badges
  remain unchanged. Current or queued work still requires a connected tablet;
  the exception never overrides outstanding assistance.
- Missing roster/start/progress data, disconnection on rings with work, and outstanding assistance
  produce explicit unavailable reasons. An unknown queued predecessor blocks
  later predictions on that ring without discarding earlier valid projections.
- Estimated starts and ring hover help expire without a successful refresh, even
  when a drag/interaction temporarily pauses normal polling.
  A tile's expired start becomes `Start TBD (stale)` without removing its duration.

### Initial model and confidence

The existing **seven minutes per saved competitor** remains the total division
baseline; it is not a learned or calibrated average. Total ring time assumes
every saved competitor participates in all applicable disciplines (Weapons only
where applicable). This is a rough total, not a separate per-discipline timing
calculation; the seven-minute baseline is unchanged. Applicable server-defined
phases (including Weapons where appropriate) use equal work shares. Reported
progress reduces remaining work; after at least 10% overall progress, slower
observed pace extends it. Faster early progress never accelerates the model
below the baseline pace. A running division retains at least two minutes of
remaining work until staff/tablet completion is reported.

Every queued start includes a two-minute transition. The model assumes prompt
manual starts, existing queue order, and no unreported breaks. Windows use 25%
uncertainty, accumulated through preceding work and transitions; current-work
uncertainty has a two-minute minimum and expands for overdue work without useful
progress. Confidence is explicitly **low**. Future assistance, staffing changes,
scheduled breaks, ring suitability constraints, and actual call times cannot be
predicted by this initial model.

### Shared API for future monitors

`GET /api/rings` includes an additive `estimates` field.
`GET /api/rings/estimates` returns that same versioned projection contract
without competitor rosters, names, dates of birth, tablet identities, or results.
Both load saved divisions for the **active event**, set `Cache-Control: no-store`,
and return HTTP 409 if the active event changes while loading. The optional
`?eventName=...` guard rejects a mismatched event. Loading failures return HTTP
500 rather than an empty successful forecast.

The snapshot contains:

- `version: 1`, `eventName`, `generatedAt`, `validUntil`, `status`, `reason`,
  `advisory`, `policy`, and human-readable `assumptions`.
- `rings[]`: ring identity/connection, `current` (or `null`), ordered `queue[]`
  with division IDs/positions, and `availability` after the queue. Current work
  includes `remainingMs` and a `completionWindow`; queue entries include
  `durationMs`, a start `window`, and a `completionWindow`.
- `unassigned[]`: independent hypothetical starts, division IDs, duration,
  and suggested ring identity where available.
- Estimated ring availability and unassigned suggestions include `planningOnly`
  to distinguish an empty unconnected ring from operationally connected capacity.
- Estimated items have `status: "estimated"`, `confidence: "low"`, and ISO
  `earliestAt`, `expectedAt`, `latestAt` timestamps in their window. Unavailable
  items instead have `status: "unavailable"`, a `reason`, and `window: null`.

Snapshot `status: "ready"` means the active-event snapshot was built, not that
every ring has an estimate. With no active event the snapshot is explicitly
unavailable. A consumer must verify event identity, version, item status, window
ordering, and freshness before presenting predictions. Reject future/invalid
timestamps and discard forecasts by `validUntil`, never later than 30 seconds
after `generatedAt`. Expiry may be earlier when a tablet approaches the normal
90-second disconnect threshold. Refresh at the day-of pages' 10-second cadence;
keep visible unavailable/stale status on errors rather than retaining old times.
Times include dates when needed for queues extending into another day.

The audience-safe projection endpoint is support for future monitor development,
not a separate access-control boundary. Audience Monitor and competitor-facing
UI, automatic scheduling, simulation, learned timings, and Android changes are
deliberately deferred. Validate with `npm test` and `git diff --check`.

## Tooltip and UI cleanup checkpoint: 2026-10-25

Branch `feature/tooltip-updates` builds on `feature/tournament-day-of` and
includes:

- One page-level **?** control per completed page, replacing scattered help
  icons with consolidated, scrollable guidance that includes details panels.
- Consistent action hover/focus explanations, including Import CSV, Clear,
  Next: Build Groups, queue maintenance, and dynamically rendered controls.
- Shared tooltip/modal assets across integrated workflows, standalone Ring
  Assignment, Event Progress/administration aliases, and the competitor roster.
- Keyboard access, Escape dismissal, focus restoration, viewport-positioned
  tooltips, and refreshed guidance when the selected page or ring state changes.
- Reduced routine instructional text while preserving visible status, errors,
  stale-data warnings, validation, and destructive-action confirmations.
- Compact two-line Ring Assignment cards: identity/connection on the first
  line, assignment/queue count on the second. The responsive grid preserves
  stable label order and existing click/drag assignment behavior.
- Automated help, action-coverage, page, and workflow regression tests wired
  into `npm test`.

Refresh the browser to load this checkpoint; no backend or dependency changes
are introduced here. Validate with `npm test` and `git diff --check`.
Prediction/estimation work starts on `feature/prediction-estimation` from this
checkpoint to retain the reviewed UI. It does not yet implement start-time
predictions, automatic scheduling, or a new audience monitor.

## Development checkpoint: 2026-10-25

This checkpoint integrates the day-of Ring Assignment and Head Table workflows
into Tournament Management:

- Active-event-only saved divisions and ring operations, with explicit errors
  when event context changes or cannot be verified.
- Compact division tiles, reliable mouse drag assignment, stable ring ordering,
  distinct connection states, and selected-ring details.
- Confirmed layout application/reset, subdued queue maintenance controls, and
  Show/Hide competitor lists with ten rows before independent scrolling.
- Head Table primary counts in Available, Active, Disconnected, Assistance
  order, with quieter queue/completion counts and overall tournament progress.
- Compact segmented phase pills, app-reported progress fills, and unfilled
  previews of the next queued division. Weapons adds its applicable phase.
- Priority/ring ordering, timing and attention details, preserved history/list
  state across refreshes, and explicit stale-data warnings.
- Confirmed assistance clearing protected by active-event and request-timestamp
  checks. Legacy clients without the optional guards remain compatible.
- Automated integration, page-contract, and ring-contract regression coverage.
  Validate with `npm test` and `git diff --check`.

Restart the server and refresh the browser to load both backend and UI changes.
No dependency changes or automatic ring-layout resets are introduced.
The standalone Ring Assignment page also retains its related active-event and
details-panel updates.

Tooltips at this checkpoint supplemented, rather than replaced, instructional text.
Late-ring priority and details are implemented; a dedicated amber pace indicator
is not. Viewer/competitor enhancements and tournament simulation are future work,
not part of this checkpoint. No Android tablet-project changes are included.

## Consistent contextual help

Tournament Management (Event Setup, Import, Group Builder, Ring Assignment,
Head Table and their details panels), standalone Ring Assignment, Event Progress
and administration aliases, and the competitor roster use shared help styling
and behavior from `assets/help-tooltips.css` and `assets/help-tooltips.js`.

Each completed page has **one ? button** in its header. Click/tap it, or use
Enter/Space while focused, to open that page's consolidated guidance, including
its details panel. Help opens as a scrollable modal with keyboard focus contained
inside; Close help, Escape, or clicking the backdrop dismisses it and returns
focus to the help button. Incomplete placeholder views do not show a help button.
Changing integrated views updates the help content without accumulating buttons.

Action buttons separately provide short hover/focus explanations of their
outcomes, including Import CSV, Clear, Next: Build Groups, maintenance actions,
and dynamically rendered details controls. Existing data hover summaries use
the same tooltip styling. Tooltips are viewport-positioned to avoid panel
clipping; Escape dismisses them and they remain readable when hovered.
Neither hovering nor focusing an action activates it. Data summaries can also
be read in the selected item's details.

Page descriptions, ordering instructions, metadata guidance, assignment
instructions and assistance-clear guidance move into contextual help. Import
keeps concise roster/load/input status visible. Live counts, empty states,
errors, stale-data warnings, validation, and destructive confirmations remain
visible; these are not hidden as instructional text.

To add a page, mark its container with `data-help-page="key"` and
`data-help-title="Page name"`, and mark its header with `data-help-root`.
Use `data-help` on actions for brief explanations. Use
`data-help-source="Section heading"` on instructional text for consolidated
guidance; sources outside the page container, such as details-panel guidance,
use `data-help-for="key"` (`*` for the current page overview).
Source text remains visible if the help script cannot load.
Dynamic sources keep descriptions up to date. Native `title` summaries
are upgraded to shared tooltips without changing the original action.
Run `npm test` for help behavior and workflow regressions.

## Pre-tournament management

Start the server with `node group-server.js` and open `http://localhost:3000/`,
which redirects to the integrated interface at `/tournament-management/`.
Use its sidebar to move between Event Setup, Import, and Group Builder.
Direct workflow links are available:
- Event Setup: `/tournament-management/?view=event-setup`
- Import: `/tournament-management/?view=import`
- Group Builder (including review and save): `/tournament-management/?view=groups`
- Ring Assignment: `/tournament-management/?view=ring-assignment`
- Head Table: `/tournament-management/?view=head-table`

On pre-tournament views the banner describes the **selected event**, including its configured event date
(not today's date) and status: Not active, Active, or Unsaved changes.
No selection and missing dates are labeled explicitly. The separate Active Event
indicator identifies the event used by day-of workflows.
On day-of views the banner switches explicitly to **Active Event** and uses that
event's configured date. Selecting a different event for preparation does not
change the day-of context; activation remains explicit. Day-of navigation stays
locked when no event is active or the active context cannot be loaded. An open
day-of view reports No active event or Unavailable rather than falling back to
the selected event. Ring Assignment and Head Table are integrated; the other day-of sections remain placeholders.
Restart the server after backend changes; refreshing the page alone does not reload server code.

### Integrated Ring Assignment

Ring Assignment shows only the active event's saved divisions, not the selected
preparation event or unsaved Group Builder drafts. Available divisions appear
on the left; all operational rings and their connection/assignment states appear
in the main workspace. Select a ring to display its current division, queue,
tablet, phase/progress, check-in, assistance, and heartbeat information in the
existing details panel. Click a division to queue it to the selected ring, or
drag it onto any ring. Division names in the details panel are plain text;
compact **Show competitors / Hide competitors** controls toggle the roster.
Remove is a low-emphasis queue action; Reset ring is a subdued maintenance
action separated below the details and still requires confirmation.
Queue removal and confirmed ring reset use the existing ring APIs.
The board refreshes every ten seconds while this view is open and also has a
manual Refresh action. Errors are displayed explicitly. Requests include the
active event name so a change of active event rejects stale ring operations.
Mouse dragging uses pointer capture to remain reliable in the VS Code embedded
browser. Tile refreshes pause during dragging and resume after drop or cancellation.
Ring tiles distinguish connection (green Connected, red Disconnected, or gray
No tablet badges and left-edge accents) from assignment (Available, Queued, or
Running division). The blue outline remains reserved for selection or a drop
target. Rings stay in label order regardless of connection or assignment changes.
Ring Assignment cards use two compact lines: ring name with connection status,
then assignment status with queue count. Cards wrap into a responsive grid
without horizontal scrolling and remain distinct click/drag targets.

Saved event layout dimensions and the operational ring layout are separate.
When they differ, **Apply saved event ring layout** offers an explicit,
confirmed operation; opening the page never resets assignments automatically.
Applying a layout clears all ring assignments, queues, completed-division
history, tablet connections, and progress for the active event. Operational
layouts support 1-26 letter columns and 1-50 numbered rows. Zero dimensions
remain valid event metadata but cannot be applied as an operational layout.

### Integrated Head Table

Head Table monitors the active event only. Primary status indicators appear in
this order: Available divisions, Active divisions, Disconnected rings, and
Assistance requests. Disconnected and Assistance are highlighted only when
nonzero. Queued and Completed division counts and overall completion out of total
divisions appear in a quieter secondary row. There is no Connected count;
individual rings retain their connection badges. These indicators are not
buttons and do not change ring ordering. A disconnected ring retains its division.
The compact overview shows ring identity, connection, an assistance indicator,
and one segmented progression pill per ring. Equal-width segments represent only
the applicable phases reported by the server: completed phases fill green, and
the current phase fills blue as the app reports progress. Segment labels and
dividers remain visible; widths do not represent estimated durations.
Queued rings preview the next division's applicable phases as labeled,
unfilled segments before it starts. The server provides this preview using the
same phase definitions as active divisions; restart the server to enable it.
Empty rings show a neutral status pill rather than invented phase progress.
Division names, queue depth, attention messages, elapsed/estimated times, and
assistance type/wait time are in Ring Details (with overview hover summaries).
Missing estimates or timing are explicitly unavailable, not "on time."

Priority order puts medical assistance first, other assistance next, then active
divisions with connection problems, connected rings needing work, and late rings.
Ring order is also available. Positions are held while the overview is being
interacted with or ring details are open; closing details resumes priority sorting
when Priority order is selected.
An explicit order change takes effect immediately.

The existing details panel shows tablet/heartbeat information, full phase timing,
check-in, sparring bouts/byes when applicable, the full queue, expandable phase
history, and a Show/Hide competitors list (ten rows before scrolling).
Head Table does not duplicate queue editing or reset controls; use its
Open Ring Assignment shortcut for those operations.

Assistance can be cleared after confirmation that it has been addressed.
This uses the existing clear API, not a new acknowledgement workflow. Clearing
checks both the active event and the request timestamp to reject stale actions.
The board polls every ten seconds while open, reports last successful refresh,
and flags failed refreshes or data older than thirty seconds as stale.
Assistance clearing is disabled whenever data is stale. Old data can remain
visible after a same-event board failure; losing the active context clears
the view rather than using selection.
Restart the server after backend changes to load the assistance timestamp check.

### Integrated Import and Group Builder

The Import page loads the selected event's saved roster. With saved competitors
and no pending CSV input, **Next: Build Groups** is the default action, even when
divisions already exist. Selecting a CSV file or entering CSV text switches the
default to **Import CSV** and disables Next until the import succeeds or the
inputs are cleared. An absent database or empty roster defaults to **Import CSV**;
the server initializes a missing database when importing. A failed roster load
is shown as an error, not an empty event.

Replacing an existing roster requires confirmation. A successful import clears
the integrated Group Builder's old in-memory state and this event's browser draft
before continuing. Without reimport, existing saved groups/drafts remain available
to Group Builder. Group building and saving remain separate, explicit actions.
Reimport replaces the whole roster rather than merging it and removes its saved
division assignments. Existing ring assignments and results are **not** cleared;
review them separately. Clearing CSV inputs does not clear saved registration.
Historical import warnings are not persisted and show as unavailable on a fresh
page visit, not as zero. Saved divisions load from the requested event's database
even when it is not the active event at server startup.

Group Builder distinguishes saved divisions from unsaved changes. Saved,
fully assigned groups emphasize **Go to Event Setup to Activate** when the event
is not already active, rather than highlighting **Save & Finish Setup**.
Editing groups (including drag-and-drop) highlights Save and hides the activation
shortcut until the changes are successfully saved. Browser drafts are treated
as unsaved work.

### Retired pages and bookmark compatibility

The standalone setup hub, event definition, import, build, and review/save pages
and their duplicate frontend script have been removed. Their former URLs redirect
to the matching integrated view, including bare paths, trailing slashes, `.html`,
and `/index.html` variants:

| Former URL prefix | Integrated view |
| --- | --- |
| `/tournament-setup`, `/tournament-mgmt`, `/setup`, `/event-administration`, `/tournament-setup/event-definition` | Event Setup |
| `/tournament-setup/import` | Import |
| `/group-builder`, `/tournament-setup/build-groups`, `/tournament-setup/review-save` | Group Builder |

Legacy group/review links with `?source=saved` retain that option to open database
groups rather than a browser draft. Editing those groups removes that option so
a refresh can resume the new draft. The retired `build-groups/app.js` is no longer
served. Day-of workflows and stored event data are retained.

Run `npm test` to validate event configuration, routes, import/resume behavior,
saved/modified group actions, division persistence, and ring contracts.

Saving divisions resolves review competitors against the selected event's current
roster, so a roster re-import does not leave the draft tied to obsolete database
IDs. Association number, name/date of birth, and unique email matches take
precedence over database IDs. Unmatched or ambiguous competitors fail the save
and roll back the division changes rather than assigning the wrong roster row.
Run `node --test tests/competitorStore.test.js` for the save regression tests.

## Multi-Surface Tournament Backend

This branch is being used to document a proposed split of tournament surfaces by
port and operational purpose:

- `3000` Pre-Tournament
- `3001-3009` Day-of Event surfaces
  - `3001` Ring Assignment Operations
  - `3002` Event Progress / display-only
  - `3003` Medical
  - `3004` Administration Progress View
  - `3005-3009` Reserved for additional Day-of surfaces
- `3010+` Post-Tournament

The goal is to keep the surfaces loosely coupled while sharing the same server
backend and data model.

The active surface can be selected with the `TOURNAMENT_SURFACE` environment
variable. If unset, the server defaults to `pre`.
Use `monitoring` for the public Event Progress view and `adminProgress` for the
Administration Progress View.
Exact entry points:
- `http://localhost:3002/event-progress/` for the public Event Progress view
- `http://localhost:3004/administration-progress/` for the Administration Progress view
Launcher: [launch-surfaces.ps1](./launch-surfaces.ps1)

Ring layout dimensions are saved in each event's `event-config.json` as numeric
`ringConfigX` (Ring Config Columns, shown as letters) and `ringConfigY` (Ring Config
Rows, shown as numbers) fields (non-negative whole numbers; blank inputs
default to zero). Creating or modifying an event saves both dimensions. Older
`ringConfig` strings such as `"2 x 3"` are read for compatibility and converted to
numeric fields on the next save.

## Group storage cleanup

The server now treats the database and in-memory store as the active source of
truth for groups/divisions. Legacy filesystem group folders are no longer part
of the event lifecycle.

### What changed
- Root `groups/` folder lifecycle handling was removed
- Per-event `groups/` folder creation and deletion was removed
- Group lookup, `/api/groups`, division build/save, and ring flow still work
  through the live in-memory store populated from the database

### Practical effect
This reduces stale filesystem state while preserving the current runtime
behavior for divisions and ring assignment flows.

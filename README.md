# tournament-server
Tournament Management Server Source

Feature overview for Audience Monitor, Competitor Lookup, and Day-of clocks:
[docs/audience-monitor-lookup.md](docs/audience-monitor-lookup.md).

Rehearsal and developer instructions are maintained separately in the
[Simulator guide](docs/simulator-guide.md).

## Release checkpoint: 2026-10-29

This checkpoint completes the simulator timing and audience-view work before
starting judges and volunteers database changes:

- Isolated rehearsal runs with scaled timing, per-ring scheduling, saved history,
  lifecycle controls, and read-only Ring Assignment, Head Table, and audience views.
- Shared running-order and timing rules, explicit two-day release, division badges,
  and Special Dragons display terminology.
- Atomic JSON persistence and failure/recovery coverage for simulation state.
- Local server maintenance through the managed launcher and separate Admin page.
- One Event Setup save action, automatically derived operational ring layouts,
  all-settings locking after operational use, and an archive-first Reset run
  that preserves competitors, prepared divisions, and event settings.

Validation: `npm test` passed all 246 Node test cases and the ring-contract suite;
`git diff --check` passed. Runtime event data, databases, results, and simulation
workspaces are excluded from source control. Restart running server processes
and refresh browser pages to load the updated backend and UI.

## Available division badges

### Tournament running order and event days

Event Setup saves **Event format: One day / Two days**; existing events default
to one day. Group-building gender separation is unchanged. Available divisions
and their planning estimates use BB oldest age bracket first, then TT/SD
together youngest first, then Gup youngest first, without gender priority.
Division numbers are stable identities and break ties within an age bracket.
Mixed age bands use the actual age range and show a **Mixed ages** label.

The Available divisions search is replaced by **All / BB / TT / SD / Gup**
filter buttons with counts. Multiple categories may be shown together; clearing
the selection returns to All. Filters only change visibility, never assignment
or forecast priority. Existing manual assignment remains possible.

For two-day events, Day 1 is BB only. Day 2 divisions remain visible (marked
**Day 2 - locked**, not draggable) but cannot be assigned or given projected
start times before release. The list opens filtered to BB; select All to preview
Day 2. Ring Assignment shows a format badge ("One-day event", "Two-day event -
Day 1 (BB)" or "Day 2 (TT/SD/Gup)"), a link to Event Setup (or a locked note once
competition starts), and the banner shows the format beside the event date.
After every BB
division is completed and its results saved, Ring Assignment enables
**Start Day 2**, with confirmation. Day 2 contains TT/SD then Gup; no automatic
overnight restart or guessed break length is used. Overall tournament completion
is unavailable until Day 2 starts. Full assignment reset or run reset clears the Day 2
release when resetting the event. All event settings, including event format and
ring dimensions, lock once operational use begins. Ordinary ring/assignment resets
do not unlock configuration; use **Reset run / Return to preparation**.

Available-pool division cards show compact **TT**, **SD**, **Gup**, or **BB**
badges: Tiny Tiger (TTLD), Special Dragons, G10-CDB, and D1-D3 respectively.
Special Dragons takes precedence over rank categories. A Black Belt division
containing a manually added CDB remains BB; a CDB-only ordinary division is Gup.
Badges and Special Dragons display names are derived without changing saved
division names, rank codes, or the database's Special Needs flag. Search matches
the displayed Special Dragons name. Group Builder and Head Table labels and
Audience View descriptions use the same terminology.

## Build Groups: firm division rules

Every ordinary generated division contains a **single gender, a single rank tier**
(TTLD, G10–G5, G4–CDB, Dan) and **a single age bracket** (6–9, 10–13, 14–17,
18–35, 36+). Divisions below the minimum size of 4 merge only into a
neighbouring division that satisfies all three rules (previous first, then
next; merges above the maximum are re-sliced evenly). When no compatible
neighbour exists, the division stays small, carries a warning, and appears in
the **Undersized** count for manual review; it is never forced into an
unrelated division.

Special Needs competitors are separated before ordinary grouping. Within
Special Needs, divisions are divided by **gender**, then **Black Belt versus
Gup** (CDB is Gup), then **Under 13**, **13-17**, or **18 and up**. TTLD remains
a separate Special Needs rank category. Oversized divisions split within the
same category; undersized divisions stay separate for review. Special Needs
competitors never merge with ordinary groups. Manual moves may cross age and
rank categories within Special Needs, but must retain gender separation and
isolation from standard divisions. Saving preserves those manual combinations,
with server-side checks against the saved roster. Automatic rebalancing still
does not combine different age or rank categories. Manually combined cards
show mixed ranks or mixed age bands rather than the first member's category.
Group Builder displays this category as **Special Dragons**, including the count,
division labels, and member badges. Stored names, flags and import columns retain
**Special Needs**; display mapping does not rewrite event data.
Missing gender, invalid age, or ineligible rank requires review before grouping.

CSV imports accept both `Special Needs` and `Special Needs (Y|N)` column
headings. Use explicit `Y` or `N` on each row; existing blank fields continue
to import as No for compatibility. The revised 400-person test roster contains
8 Special Needs competitors (2%), aged 13-30. Existing event databases and
browser drafts are not automatically repaired: re-import the corrected CSV,
then rebuild and review groups before saving.

Group Builder scrolls the division list and the selected division's competitor
list independently. On desktop, both panels fit the viewport, keeping headings
and builder controls visible. On narrow screens, the lists have capped heights
and scroll within the page. Scrolling one list does not move the other.
Empty cards are also distinguished: a new division awaiting competitors uses
a neutral dashed card; a previously populated division that becomes empty uses
a red-tinted **Emptied** card. Adding competitors clears the empty styling.
This history is retained in browser drafts; older empty drafts without history
are treated as awaiting competitors.

## Integrated Competitor Lookup

Open **Competitors** in Tournament Management, or use
`/tournament-management/?view=competitors`. This staff-facing lookup uses the
**active event's saved roster**, independently of the selected preparation
event or unsaved group-builder drafts.

- Enter **at least two characters per term** of first name, last name, or rank.
  Separate multiple terms with commas for **OR matching**: `Anna, G1` finds
  anyone matching Anna or G1. Terms are trimmed and deduplicated; empty and
  single-character terms are ignored. Each competitor appears only once.
  Case-insensitive literal substring matching displays **all matches**, sorted
  by last name then first name. Matching characters are highlighted; studio,
  parent name, and phone are not search fields.
- A styled search toolbar provides Search, collapsible Filters, Refresh, and
  the actual result count. Live search still runs while typing; Search and
  Enter explicitly run the same search without new API calls.
- Advanced filters provide full-name substring, exact rank/studio/division/ring,
  and **Show only unassigned** controls. Apply combines the advanced conditions
  with AND within the existing comma-separated OR search. A blank search with
  applied filters can search the roster through filters alone. Unassigned means
  no identifiable current/queued/completed ring; unavailable ring data is not
  treated as unassigned. Closing Filters only hides it; Clear filters removes
  applied conditions without changing search text. Event changes reset filters.
- An aligned table shows Competitor, Rank, Studio, Division, and Ring.
  When the results area is at least 760px wide, advanced filters align with
  those same columns using shared widths, with more room for Name and Studio.
  In narrower results areas, filters wrap into a compact grid instead.
  Base rows are 42px high with 14px text, restrained rank chips, highlighted
  matches, subtle alternating backgrounds, and a blue selected-row accent.
  The Competitor heading reverses last-name/first-name sorting. All results
  remain displayed (no result cap or pagination); the footer reports the
  actual range and total, including `Showing 0-0 of 0 results` when empty.
  Main-panel results show name, rank, studio, saved group division,
  and identifiable ring. Select a result with mouse or keyboard to open the
  details panel containing **first name, last name, parent name, phone, rank,
  studio, group division, and ring assignment**. Contact fields are not repeated
  in the results. Missing contact/registration fields say **Not provided**.
- The selected detail panel has a prominent name, studio, rank badge, and close
  control, followed by Personal Information, Competition Information /
  Assignments, and Notes sections. Email, an explicit age-range value, and
  notes are shown only from existing data; no age range or notes are inferred.
  Missing notes are explicitly indicated. A subtle notice identifies an
  unassigned ring. Close or Escape from the details returns focus to search.
  Standard ten-digit phone numbers display as `xxx-yyy-zzzz` without changing
  saved values; other formats/extensions remain intact. The side panel grows
  from 420px to a 460px maximum, taking 65% of added viewport width above
  the 1380px side-by-side breakpoint until capped. Additional width then goes
  to the results panel. A fixed label column helps
  leave more room for email. The drawer also scales with viewport width and
  remains bounded by the window; unusually long addresses can still wrap.
- At viewport widths **above 1380px**, details sit alongside the results.
  At **1380px and below**, the nonmodal details drawer overlays the right side
  without shrinking the table. At **960px and below**, lookup content uses
  one main column (existing navigation remains); at **600px and below**, table
  cell spacing/type is reduced. Filter controls wrap automatically and long
  values wrap within cells instead of forcing page-wide horizontal scrolling.
- Ring labels distinguish **current**, **queued**, and **completed** history.
  Live assignments take precedence over historical completed assignments;
  multiple conflicting matches say **Ambiguous**, rather than guessing a ring.
  No division or ring assignment is explicitly reported as **Not assigned**.
- Data refreshes every ten seconds or using **Refresh**, retaining a selection
  only while that competitor still matches. Event context is checked again
  after loading; a changed/unverifiable event or failed roster refresh clears
  old results and personal details. Ring-only failures leave registration
  searchable but explicitly mark ring assignments unavailable.
- Changing pages clears the loaded lookup results/details. A nonempty search
  without a two-character term clears matches and closes the details panel.
  An empty search can still show matches when advanced filters are applied.
  The page-level **?** explains search, privacy, and assignment states.

This is a read-only **staff** feature, not a public competitor-contact screen
or part of Audience Monitor. It uses existing roster/ring APIs and introduces
no editing actions or data migrations. Refresh the browser to load this UI.
Volunteer Lookup remains future work. Validate with `npm test` and
`git diff --check`.

## Audience Monitor

On `feature/audience-monitor-lookup`, the standalone audience display is available
at **`http://localhost:3000/audience-monitor/`** (or the same path on the
monitoring server at port 3002). Head Table includes an **Audience Monitor**
link that opens a separate tab. Restart the server and refresh to load the
new routes and API. Existing Event Progress routes and surface entry points
remain unchanged.

- A stable **over/under** layout gives approximately 55% of content height to
  **Rings now**, with **Coming up** below. There is no continuous scrolling.
- The top section shows configured rings in natural ring order, current
  division descriptions, and applicable phase progression in compact 64px
  horizontal rows with audience-sized text. Every row reserves a segmented
  pill area: running divisions show progress, the first queued division previews
  unfilled applicable phases (including Weapons), and empty rings show a neutral
  **No current division** pill. Paused/unavailable rings keep a neutral status
  pill in the same space, without presenting untrusted progress. Idle rings say
  Waiting; this does not promise operational readiness. Paused or disconnected
  work uses audience-friendly messages and does not show old phase progress.
- The lower section contains **assigned queued divisions only**, with their
  ring in a prominent high-contrast badge beside the division number.
  Upcoming cards are 160px high; queue position is a separate secondary line.
  Ring names in the upper rows use larger bold text without increasing row height.
  Cards also show a description and approximate start window. Unassigned
  hypothetical suggestions are deliberately excluded. Missing predictions say
  **Start TBD**. Dates are included for future-day windows.
- Each section calculates its capacity from the available area. It advances
  complete pages every **12 seconds** only when more than one page is needed,
  wraps independently, and shows a page indicator. Live refreshes do not reset
  rotation or reorder existing rows while being read; upcoming rows are
  re-sorted by projected start at a rotation boundary. Removed rows disappear.
- **Pause pages** stops both rotations without stopping updates. **Fullscreen**
  and the page-level **?** support unattended display setup and review. The
  layout targets landscape TVs, with a 720px minimum document height; smaller
  windows can scroll the document rather than compressing cards into unreadable
  rows. Browser zoom changes the number of cards that fit.
- Data refreshes every **10 seconds**, with an eight-second request timeout.
  Staleness is checked every second. Refresh failures or expired snapshots hide
  predictions and progression, show an explicit warning, and retry
  automatically. Event changes clear the previous event's rows and reset pages.
  Status space is reserved so ordinary status changes do not shift the panels.

### Public display data

`GET /api/rings/monitor` returns a version-1 active-event-only snapshot built
from the same saved groups, authoritative phase definitions, and estimates as
the day-of pages. It uses `Cache-Control: no-store`, rejects an optional
incorrect `eventName` with HTTP 409, checks event switches during loading,
and reports saved-data loading failures with HTTP 500.

The allowlisted response contains event identity/freshness, ring labels,
division numbers/descriptions, audience status, applicable phase progression,
current completion windows where available, and assigned queue start windows.
It omits competitor rosters, individual names, birth dates, tablet identities,
assistance categories, and unassigned projections. A missing active event returns
an explicit unavailable snapshot with empty ring/queue arrays. No event
preparation selection or unsaved draft is used.

The audience page performs GET requests only and has no assignment, reset,
assistance-clear, or other operational actions. **This does not isolate the
server's other APIs or make a separate port an access-control boundary.** Use
appropriate network/access controls before exposing the server publicly.
Competitor Lookup is implemented in the integrated staff panel described above;
Volunteer Lookup remains deferred. Validate with `npm test` and `git diff --check`.

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
  Starts share a cumulative projection in division-number order, placing each
  division on the earliest free ring after its preceding projected workload.
  They do not write assignments, reorder existing queues, or promise a call time.
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

### Day-of clocks and event timing

- All Day-of pages show a running **Time** clock in the shared header banner;
  the Audience Monitor shows a large clock at the top right of its header.
- Ring Assignment and Head Table show **Event started** and **Est. completion**
  chips below their headings. Both read **TBD** until the event starts, which is
  recorded when the first ring with a **named tablet** connects, sends a heartbeat,
  or starts/completes a division (`eventStartedAt`). Requests without a tablet
  name never start the event, and the
  start is never inferred from old saved heartbeat or phase timestamps.
  The start time is cleared by Reset assignments, Reset run, and event create/reset.
  Reset assignments alone does not unlock event configuration.
- Completion (`estimates.eventCompletion`) covers current, queued **and
  unassigned** divisions: unassigned divisions, in division order, are placed
  on whichever ring frees up first. It shows `~time (window)`, **All divisions
  complete**, or **Unavailable** with the reason in its help (for example a
  disconnected ring with work or a missing roster). The displayed value refreshes
  every **60 seconds** (or immediately on event/start/status change) so it does
  not jitter on each 10-second board refresh. Restart the server after updating.

### Shared timing model and confidence

Live planning estimates and server phase estimates use timing model version 2:

| Activity | Real tournament minutes |
| --- | --- |
| Setup | 7 per group division |
| Weapons | 1.5 per weapons entrant |
| Hyungs | 1.5 per hyungs entrant |
| Sparring | 2 per contested bout |
| Review/wrap-up | 3 after each applicable competition discipline, before the next discipline or awards |
| Awards | 10 per group division |

Review time is included in the preceding discipline's phase estimate; it does
not add new tablet phase names. The standard three reviews are weapons to
hyungs, hyungs to sparring, and sparring to awards. A missing discipline has no
performance or review allowance. Single-elimination sparring uses N - 1 actual
bouts for N entrants (zero for zero or one entrant), excluding byes. Explicit
discipline eligibility/division assignments and entry statuses determine entrant
counts; scratches and no-shows are excluded. Legacy rosters without discipline
metadata assume hyungs and sparring participation, but not weapons.

Eight entrants in all three disciplines take **64 minutes**: 7 setup, 12 weapons,
12 hyungs, 14 sparring, 9 review, and 10 awards. Two such divisions per ring
take approximately **2 hours 8 minutes**, excluding unreported delays.

Reported progress is weighted by modeled phase duration, rather than equal
shares. After at least 10% overall modeled progress, slower
observed pace extends it. Faster early progress never accelerates the model
below the baseline pace. A running division retains at least two minutes of
remaining work until staff/tablet completion is reported.

No additional between-division transition is added: setup and discipline reviews
are already included. The model assumes prompt
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
- `unassigned[]`: a cumulative hypothetical schedule in numeric division order,
  with division IDs, duration, suggested ring identity, start `window`, and
  `completionWindow`. Each projected division advances that ring's availability
  before the next division is placed on the earliest free ring (ties use ring
  label order). The first wave can start now; later waves include preceding
  workloads. These same projected workloads determine event completion.
  Projections never write assignments or reserve rings. A missing roster blocks
  downstream projections rather than silently ignoring unknown work.
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
UI, automatic scheduling,
learned timings, and Android changes are deliberately deferred. Validate with
`npm test` and `git diff --check`.

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
is not. Viewer/competitor enhancements are future work,
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
Pointer hover waits 650ms before showing help and dismisses it within 100ms
of leaving, even if the control retains focus. Pointer press and drag start
immediately dismiss help and suppress it throughout the drag, including over
drop targets. Keyboard focus still shows help immediately.
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

Event Setup has one **Save Changes** action. Event configuration is authoritative;
operational layout dimensions are derived automatically on creation, saving,
activation, and reading unused event state, including for inactive events.
Layouts support up to 26 letter columns and 50 numbered rows. Zero dimensions
mean no operational rings are configured; no default 1-by-2 layout is substituted.

All event settings (labels, date, format, and layout) become read-only once any
tablet, current/queued/completed assignment, run progress, or result exists.
The lock persists across pauses, disconnects, server restarts, and individual or
full assignment resets. Existing in-use layout mismatches preserve operational
state and are reported in Event Setup; they are never automatically rebuilt.
The legacy ring configuration endpoint cannot independently change event layout,
and submitting identical dimensions preserves all ring state.

To abandon a test run, stop tablet activity, select the event in Event Setup, and
choose **Reset run / Return to preparation**. Confirmation archives results,
assignment state, and event configuration under the event's `run-archives`
directory, then clears operational state and unlocks all settings. Competitors,
prepared divisions, saved settings, and the active-event selection are preserved.
Save the new configuration and start again. **Discard edits** only reloads the
form; the older destructive `/api/events/reset` endpoint remains separate and
still removes the event database and results.

### Integrated Head Table

Head Table monitors the active event only. Counters are split into two labeled
groups. **Divisions** shows Unassigned, Queued, Active, and Completed in workflow
order, followed by a thin progress bar with completed out of total divisions.
**Rings (N)** shows Connected, No tablet, Disconnected, and Assistance; only
Disconnected and Assistance are highlighted, and only when nonzero. The groups sit
side-by-side with a divider and stack when space runs out (no divider on a new row). Individual rings
retain their connection badges. These indicators are not
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

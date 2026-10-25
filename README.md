# tournament-server
Tournament Management Server Source

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

Tooltips currently supplement, rather than replace, instructional text.
Late-ring priority and details are implemented; a dedicated amber pace indicator
is not. Viewer/competitor enhancements and tournament simulation are future work,
not part of this checkpoint. No Android tablet-project changes are included.

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

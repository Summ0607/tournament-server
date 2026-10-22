# tournament-server
Tournament Management Server Source

## Pre-tournament management

Start the server with `node group-server.js` and open `http://localhost:3000/`,
which redirects to the integrated interface at `/tournament-management/`.
Use its sidebar to move between Event Setup, Import, and Group Builder.
Direct workflow links are available:
- Event Setup: `/tournament-management/?view=event-setup`
- Import: `/tournament-management/?view=import`
- Group Builder (including review and save): `/tournament-management/?view=groups`

On pre-tournament views the banner describes the **selected event**, including its configured event date
(not today's date) and status: Not active, Active, or Unsaved changes.
No selection and missing dates are labeled explicitly. The separate Active Event
indicator identifies the event used by day-of workflows.
On day-of views the banner switches explicitly to **Active Event** and uses that
event's configured date. Selecting a different event for preparation does not
change the day-of context; activation remains explicit. Day-of navigation stays
locked when no event is active or the active context cannot be loaded. An open
day-of view reports No active event or Unavailable rather than falling back to
the selected event. Day-of sections in the integrated interface remain placeholders.
Restart the server after backend changes; refreshing the page alone does not reload server code.

Its Import page loads the selected event's saved roster. With saved competitors
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

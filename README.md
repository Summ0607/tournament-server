# tournament-server
Tournament Management Server Source

## Event metadata

Start the server with `node group-server.js` and open `http://localhost:3000/`, which
loads Tournament Setup (`/tournament-setup/`), the pre-tournament hub page.
Use the separate pages for each step:
- Event Definition: `/tournament-setup/event-definition/`
- Import Registration: `/tournament-setup/import/`
- Build Groups: `/tournament-setup/build-groups/`
- Review & Save: `/tournament-setup/review-save/`
Event details are managed at `/tournament-setup/event-definition/`.
Restart the server after backend changes; refreshing the page alone does not reload server code.

Import Registration resumes the selected event from its saved database, including
competitor and division counts. Existing rosters can continue to Build Groups
without importing again. Events with saved divisions default to **Review Saved
Divisions**, which opens database data rather than a browser review draft;
Build Groups remains a secondary option. Saved divisions are loaded for the
requested event even when it is not the active event at server startup.

**Reimport Registration** is a secondary, explicitly confirmed replacement action.
It replaces the entire roster (not a merge), removes its saved division
assignments, and discards this browser's review draft for that event. Rebuild
and save divisions afterward. Existing ring assignments and results are **not**
cleared; review them separately before resuming operations. Clearing the CSV
inputs does not clear the saved roster. Historical import warnings are not
persisted and display as unavailable on a fresh page visit, not as zero.

The integrated three-panel interface is available at `/tournament-management/`.
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

Group Builder distinguishes saved divisions from unsaved changes. Saved,
fully assigned groups emphasize **Go to Event Setup to Activate** when the event
is not already active, rather than highlighting **Save & Finish Setup**.
Editing groups (including drag-and-drop) highlights Save and hides the activation
shortcut until the changes are successfully saved. Browser drafts are treated
as unsaved work. The older standalone pages remain available for compatibility;
their cleanup is deferred to a separate change.

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

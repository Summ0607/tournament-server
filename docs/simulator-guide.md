# Simulator guide

The simulator is a rehearsal and validation tool, separate from live tournament
operations. It does not assign real rings or write to the active event.

## Running a rehearsal

1. Build and save the source event's divisions and ring configuration.
2. Open `/simulator/` and select the saved event.
3. Create a run. Optionally supply a scenario seed for repeatable results.
4. Choose a time scale, then start the run. Use pause/resume, single-ring step,
   or stop to inspect its behavior.
5. Inspect the run overview, ring progress, events, and result summaries.
6. Reset to rehearse again from the initial snapshot, or delete the isolated run.

### Preparing or changing the source event

Event Setup has one **Save Changes** action for event details, one/two-day format,
and ring dimensions. Before operational use, saving automatically synchronizes
the event's operational ring layout; activating the event is not required.
All event settings lock once real operational use begins, including while paused.
Creating or running an isolated simulation does not itself lock the source event.

For an abandoned live/test event run, stop tablet activity and use Event Setup's
**Reset run / Return to preparation**. It archives results, ring state, and event
settings under that event's `run-archives` directory, clears operational state,
and unlocks settings while preserving competitors and prepared divisions.
This differs from the Simulator page's **Reset run**, which only resets the
selected simulation workspace. After changing source settings, create a new
simulation to use them; existing simulations retain their original snapshots.

The time scale is a simulated-time multiplier. At 2x, one modeled minute takes
30 real seconds; at 5x, 12 seconds; at 20x, 3 seconds. The selector offers 2x,
5x, 10x, 20x, and faster options. The API accepts values from 1 through 3600.
The controls page initially selects 20x; API-created runs default to 600x unless
their speed is changed. Loaded runs retain their saved speed, including on reset.

## Viewing a run

### Loading and deleting history

On the Simulator page, use **Saved simulation runs / Simulation history** to
select an existing run. Entries show its source event, status, short ID, and
creation time. **Refresh history** reloads this list.

The **Saved event** dropdown is only the source tournament for creating a new
simulation; it is not simulation history.

To remove history, select the unwanted simulation, pause or stop it if running,
then click **Delete run** and confirm. Only that run's isolated data is deleted;
the real tournament is unchanged. **Reset run** instead keeps the run and its speed, clearing
its progress and results so it can be rehearsed again. Deleting a run or detecting
a missing saved run clears its displayed rings, unassigned pool, and event log.
The Simulator overview count and lower division-pool section both use
**Unassigned divisions** for divisions without an active or queued ring slot.

### Collapsible history, bulk deletion, and recent events

Both **Saved simulator runs** and **Recent simulator events** start minimized.
Buttons follow a role-based size scale: primary and restart-confirmation
buttons are 44 px tall, standard buttons 38 px, and the small Expand/Minimize
utility buttons 28 px. On touch screens every button grows to at least 44 px
(36 px for Expand/Minimize).
Use the small **Expand** button to open a panel and **Minimize** to collapse it
again. Each panel remembers its state in this browser; monitoring continues
while it is minimized.

Check unwanted saved runs, or use **Select all deletable**, then choose
**Delete selected (N)** and confirm once. **Clear selection** unchecks the list.
Running runs cannot be checked; pause or stop them first. Each run is checked
again before deletion. Runs are deleted individually using the existing isolated
delete operation; a failure does not prevent deleting the other selected runs.
The final message reports the number deleted and identifies any failures.
Deleting the currently viewed run clears its monitoring panels.

Recent events identify the selected event and full run ID and show the latest
30 matching events, newest first. New events record their actual occurrence
date/time, displayed in local time, plus separately labeled simulated elapsed
time. Historical entries without an actual timestamp say **Actual time not
recorded (historical event)**; their old virtual calendar is not presented as
an actual date. Existing logs are not rewritten.

Repetitive phase-progress updates are hidden by default, while phase completions,
queue/bootstrap activity, report/loading transitions, division completions, and
errors remain visible. Check **Show repetitive phase progress updates** for
the detailed progress log. These diagnostics are not the ring results report.

### Local server restart control

The **Admin** tab in Tournament Management (`/admin/`, separate from the
Simulator page) includes **Server maintenance - local administrator**.
Server restart is an administration function and is not on the Simulator page.
**Check server status** shows a large, color-coded, timestamped result (green:
restart available; amber: running but restart unavailable; red: not responding).
It restarts the server process serving that page, including its production
connections, not just the selected simulation. It does not restart other
independently launched surfaces. Use it only during a planned break and warn
ring operators first.

One-time setup for the existing Windows shortcut:

1. Stop the old server with Ctrl+C.
2. Right-click the shortcut, open **Properties**, and change **Target** to:
   `"C:\Program Files\nodejs\node.exe" "C:\Karate4\tournament-server\server-launcher.js"`
3. Keep **Start in** set to `C:\Karate4\tournament-server`.
4. Start that shortcut. The managed launcher stays running and starts the server.

The multi-surface PowerShell launcher also uses the managed launcher for each
surface. Existing directly launched servers must be stopped before switching;
do not start a second server on an occupied port.

On the server computer, visit `http://localhost:3000/admin/` (or the applicable
surface port). Click **Restart server...**, read the warning, type **RESTART**,
and choose **Confirm restart**. **Cancel** or Escape leaves the server running.
The server stops accepting new work, drains pending requests, stops and saves
running/paused simulations, closes its database, and asks the launcher to start
a fresh process. The page waits for a different server instance, then reloads.
Saved event data and results remain intact. Stopped simulations require reset
before rerunning; they are not automatically resumed.

The control is limited to loopback connections with a localhost/loopback Host,
same-origin checks, a per-process confirmation token, and explicit confirmation.
It is a local maintenance control, not a substitute for user-account
authentication. LAN clients cannot invoke it. A directly launched server shows
the control as unavailable instead of exiting without a relauncher.

If reconnection times out, inspect the launcher command window and use
**Check server status**. Do not start a duplicate server. A crash or failed
shutdown is logged and is not automatically restarted in a loop.

### Running order and two-day rehearsals

Saved events now have an **Event format** setting in Event Setup: **One day**
(the default for older events) or **Two days**. A new simulation snapshots that
setting; changing the source event later does not change an existing run.
Create a new run to rehearse a changed format.

Automatic simulator allocation and projected starts share this order:
Black Belts oldest age bracket first; then Tiny Tigers and Special Dragons
together youngest bracket first; then Gup youngest bracket first. Gender does
not affect scheduling. Equal brackets use numeric division number as the
tie-breaker. Mixed-age bands use their actual age range and are labeled in Ring
Assignment. Existing manual initial assignments remain deliberate overrides
of category priority, but cannot put Day 2 divisions into Day 1.

One-day runs continue filling free ring slots when earlier-priority divisions
have been assigned; they do not wait for every earlier division to finish.
Two-day runs restrict Day 1 to BB. Once every ring finishes Day 1 and saves its
results, the run enters **day-break**. Click **Start Day 2**, confirm, and it
continues with TT/SD then Gup. Both days retain their results and diagnostic
events. Day 2 does not start automatically or after a clock delay. If there are
no BB divisions, starting Day 1 reaches the checkpoint without competition.

Until Day 2 is explicitly started, its starts and overall tournament completion
remain unavailable; the overnight break is not guessed. Reset clears both days'
progress and returns to Day 1 using the saved format.

The Ring Assignment category buttons (**All**, **BB**, **TT**, **SD**, **Gup**)
only filter the visible tiles; they do not change allocation or prediction
priority. Simulator Ring Assignment remains read-only; use the Simulator page
for the Day 2 control.

### Ring Assignment

Choose a run in the **View** source selector. A prominent
**SIMULATION - READ ONLY** banner identifies the selected mode.

- View the run's isolated unassigned pool, queues, current divisions, and
  completion history.
- Select rings and show competitor lists.
- Assignment clicks, pointer/native dragging, queue removal, ring reset, and
  layout changes are blocked.
- Forecast clocks are local wall-clock times scaled by the selected speed;
  pool durations are labeled **real min**, not modeled tournament minutes.
- Paused/inactive runs retain durations but show unavailable starts.
- Refreshes occur every ten seconds. Source changes discard late responses;
  an unavailable run shows an error rather than falling back to live data.

Use the Simulator page to control execution and speed, not Ring Assignment.

### Head Table and Audience View

Both support selecting an isolated run instead of the active event. Simulation
views are read-only and clearly labeled. Audience snapshots contain public
division descriptions and progress, not competitor records. Queued start
predictions use the local wall clock and accelerated remaining work.

## Timing and interpretation

Execution uses the same phase baseline as live planning estimates. See
[Shared timing model and confidence](../README.md#shared-timing-model-and-confidence)
for setup, entrant, bout, review, and awards allowances.

Eight entrants in all three disciplines take 64 modeled minutes per division.
Two such divisions per ring take about 128 modeled minutes: 64 real minutes at
2x or 25.6 at 5x, excluding small protocol overheads and unreported delays.
Timing has no random pace variation; scenario seeds affect generated results.
Phase progress updates four times per phase. Rings advance independently.
After awards reach 100%, a ring displays **Uploading report** while preparing
and saving its run-scoped JSON results, then **Loading division** before setup
for its next division. Each transition has a 30-second modeled protocol allowance,
scaled by the selected speed; actual file operations can add overhead. These are
simulator-only operation states, not new production/tablet competition phases.
When no divisions remain for the ring, its phase is **Idle**, not Waiting.
Pause/resume preserves pending operation time; speed changes rescale remaining
time rather than skipping it.

The overview records local-clock start and completion times. Its start label is
**Tournament started** and its running forecast is **Estimated Tournament Completion**.
While running, its
finish forecast includes remaining phase work, queues, and unassigned divisions
projected onto the earliest available rings. It is approximate, not a guaranteed
scheduler finish. Paused, stopped, or failed runs have no live finish estimate.
Reset clears timestamps; historical runs lacking them show "Not recorded".
After a timing-model update, restart the server and create or reset a run;
historical logs and results are not rewritten.

## Isolation, assignments, and recovery

Each run snapshots saved groups and initial assignments under
`simulator-runs/<runId>/`: `groups.json`, `initial-ring-assignments.json`,
run-only `ring-assignments.json`, `manifest.json`, and `results/`.
The source event's database, assignments, results, and active-event pointer
remain unchanged.

Each ring initially queues at most one division, using its first saved manual
assignment when present. On activation it draws the next division from the
shared pool into its single queued slot. Remaining manual assignments and
unassigned incomplete divisions share that pool; completed groups are excluded.
Creation rejects missing source files, no eligible groups, and missing or
duplicated division references.

Stop preserves workspace progress. Reset restores initial assignments and clears
only that run's results, preserving speed. Delete removes only the named run.
In-progress runs discovered after a server restart are failed and require reset.

Assignment, manifest, and result saves use atomic replacement with unique
temporary files. `EPERM`, `EACCES`, and `EBUSY` failures retry up to five times,
with 620 ms total waiting per save. Synchronous retries briefly delay server
work; they never delete an existing file to force replacement. Failed saves
clean up their temporary file and log cleanup errors.

In-memory assignments advance only after successful replacement. A result saved
before an assignment failure remains deduplicated by submission ID. Persistent
failures visibly fault the ring/run rather than skipping work. Release file locks
or correct access, then reset; faulted runs are not automatically repaired.

## Developer reference

### APIs

All paths below are under `/api/simulator/runs`.

| Method and suffix | Purpose |
| --- | --- |
| `GET /` | List runs |
| `POST /` | Create from explicit `{ "eventName": "..." }` |
| `GET /:runId` | Manifest, diagnostics, progress, and result summaries |
| `POST /:runId/start` | Start asynchronous execution |
| `POST /:runId/step` | Advance one operation with `{ "ringId": "ring-a-1" }` while created or paused |
| `POST /:runId/pause`, `/resume`, `/stop` | Lifecycle controls |
| `POST /:runId/speed` | Set `{ "speed": 20 }` |
| `POST /:runId/reset` | Restore isolated initial state |
| `DELETE /:runId` | Delete the run workspace |
| `POST /:runId/run` | Wait synchronously for completion |
| `GET /:runId/log` | Ordered events and errors |
| `GET /:runId/results` | Run-scoped result summaries |
| `GET /:runId/ring-assignment` | Read-only assignment board and scaled predictions |
| `GET /:runId/head-table` | Read-only Head Table projection |
| `GET /:runId/audience` | Public audience projection |

### Engine and reproducibility

`backend/dayOfSimulator.js` orchestrates prebuilt groups and ring assignments:
queue, bootstrap, phase heartbeats, completion packet, then the next assignment.
`step()` advances one operation. `runToCompletion()` runs without wall-clock
delays, whereas asynchronous start honors speed.

Clients must declare matching `simulationScope` and implement `queue`,
`bootstrap`, `heartbeat`, and `complete`. The run-scoped adapter never invokes
active-event ring routes or writes to the event result store.

`getState()` includes status, virtual time, operation count, ordered events,
errors, and per-ring active phase, queued/pending/completed groups, counts, and
failure details. Running to completion allows other rings to continue after one
fails, then returns failed status; individual steps still throw errors.

Reproducibility metadata includes scenario ID/seed, `startAt`, `stepDurationMs`,
and the SHA-256 fingerprint of group and initial-assignment snapshots. The same
seed, start time, groups, and assignments reproduce the scenario; its ID is
derived from those inputs unless supplied explicitly. Packets include run,
scenario, seed, and simulated completion time.

### Sparring result generation

Packet builders receive `selectEligibleSparringCompetitors()` and
`simulateSparringDivision()`. Entrants must be checked in with sparring
registration `REGISTERED`. Brackets use height ordering, roster-stable seeded
byes, and adjacent same-studio swaps when the next bout is within four inches.

Generated outcomes model one-point deductions per two standard warnings,
disqualification at three warnings, first-to-three/time-expired results, and the
app's rounds and placement labels. Seeded results are repeatable. This is a
server-side port, not execution of Android/Kotlin code; app parity changes need
matching implementation and regression tests.

### Validation

Run `npm test` and `git diff --check`. Focused coverage includes simulator timing,
engine/integration, run store, scheduler, assignment projections, and viewer
read-only/source-switch regressions. Rehearsals should compare predicted starts
with observed ring transitions and verify independent progress for unequal
division sizes.

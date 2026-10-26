# Feature: Audience Monitor, Competitor Lookup, and Day-of Clocks

Branch: `feature/audience-monitor-lookup` (builds on `feature/prediction-estimation`).

This feature adds a public Audience Monitor, a staff Competitor Lookup, Day-of
clocks with event timing, and Head Table / tooltip refinements. All Day-of
pages work against the **active event only**. Detailed behavior for each area
is also described in the main [README](../README.md).

## Summary

| Area | What it provides | Audience |
|---|---|---|
| Audience Monitor | Over/under TV display of rings now and upcoming queued divisions | Public |
| Competitor Lookup | Search, filter, and inspect active-event competitors and ring assignments | Staff |
| Day-of clocks | Running current time on all Day-of pages and the Audience Monitor | Staff / public |
| Event timing | Event started and estimated completion on Ring Assignment and Head Table | Staff |
| Head Table counters | Separate Divisions and Rings counter groups with progress bar | Staff |
| Help tooltips | Delayed hover help that never blocks drag-and-drop targets | Staff |

## Audience Monitor

- URL: `http://localhost:3000/audience-monitor/` (also on the monitoring
  server port 3002). Head Table links to it in a new tab.
- API: `GET /api/rings/monitor` returns a public projection built by
  `backend/audienceMonitor.js`. It contains ring labels, division
  descriptions, applicable phase progression, and assigned queued divisions
  with start windows. It never contains competitor names, contact data,
  tablet names, or other private operational fields.
- Layout: **Rings now** (about 55% height, compact 64px rows, every ring has a
  segmented progression pill, including **No current division**) above
  **Coming up** (160px cards with a prominent high-contrast ring badge and a
  separate queue-position line). Unassigned hypothetical suggestions are
  excluded.
- Each section pages independently every 12 seconds when needed. **Pause
  pages**, **Fullscreen**, and page help are provided.
- Data refreshes every 10 seconds. Stale or failed data hides progression and
  predictions and shows an explicit warning until recovery.
- A large running clock sits in the header.

## Competitor Lookup (staff)

- Open **Competitors** in Tournament Management
  (`/tournament-management/?view=competitors`).
- Search by first name, last name, or rank with at least two characters per
  term. Comma-separated terms are OR-matched, and matches are highlighted.
- Collapsible advanced filters (Name, Rank, Studio, Division, Ring, Show only
  unassigned) combine with AND and align with the results table columns on
  wide layouts.
- The results table shows Competitor, Rank, Studio, Division, and Ring with
  sortable names and a real result count footer.
- The details panel shows personal information (including the phone formatted
  as `xxx-yyy-zzzz`), competition information, ring assignment, and notes,
  without inferring missing data. It sits beside the results above 1380px
  and becomes an overlay drawer at narrower widths. Its width adapts from
  420px to a 460px maximum.
- The lookup is read-only and uses existing roster and ring APIs.

## Day-of clocks and event timing

- **Current time:** shown in the shared header on Ring Assignment, Head Table,
  Competitors, and the placeholder Day-of pages, and in the Audience Monitor
  header. Updates every second.
- **Event started:** shows `TBD` until the event starts. The start
  (`eventStartedAt`) is recorded only when a ring with a **named tablet**
  connects, sends a heartbeat, or starts or completes a division. Requests
  without a tablet name never start the event, and the start is never
  inferred from old saved heartbeat or phase timestamps.
- The start is cleared by **Reset assignments**, **Apply layout**, and event
  create or reset.
- **Est. completion:** computed server-side as `estimates.eventCompletion` in
  `backend/ringEstimates.js`. It covers current, queued, and unassigned
  divisions. Unassigned divisions are placed in division order on whichever
  ring frees up first. The result is shown as `~time (window)`, **All
  divisions complete**, or **Unavailable** with the reason in its help text.
  The displayed value refreshes every 60 seconds, or immediately when the
  event, start, or status changes.

## Head Table counters

- **Divisions:** Unassigned, Queued, Active, and Completed, in workflow order,
  followed by a thin progress bar showing completed of total.
- **Rings (N):** Connected, No tablet, Disconnected, and Assistance. Only
  Disconnected and Assistance are highlighted, and only when nonzero.
- The groups sit side by side with a divider, and stack when space runs out.

## Help tooltips

- Hover help appears after 650ms and hides 100ms after the pointer leaves.
- Pressing a pointer or starting a drag hides help and suppresses it until
  the interaction ends, so drop targets are never covered.
- Keyboard focus still shows help immediately.

## Files

| File | Change |
|---|---|
| `audience-monitor/index.html`, `monitor.js`, `monitor.css` | New public display |
| `backend/audienceMonitor.js` | Public monitor projection |
| `backend/pages.js` | `/audience-monitor/` routes |
| `backend/ringRoutes.js` | Monitor API, event start requires a named tablet |
| `backend/ringEstimates.js` | `eventCompletion` forecast |
| `group-server.js` | Layout apply clears start, no inferred start |
| `tournament-management/index.html` | Lookup, clocks, event timing, Head Table counters |
| `assets/help-tooltips.js` | Delayed hover and drag suppression |
| `tests/*` | Monitor, lookup, estimates, tooltip, and ring contract coverage |

## Operations

- Restart the server after deploying, because there are backend route and
  estimate changes. Refresh browsers to load the UI.
- No new dependencies or data migrations are required.
- Existing saved start times are not rewritten. To clear an incorrect one,
  use **Reset assignments** or **Apply layout**, which also clears queues.

## Testing

```powershell
npm test
git diff --check
```

The tests cover the public monitor projection and display behavior, lookup
search, filters, and details, completion forecasting, the clock and timing
displays, tooltip timing, and the rule that the event start requires a named
tablet.

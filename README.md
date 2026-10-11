# tournament-server
Tournament Management Server Source

## Event metadata

Start the server with `node group-server.js` and open `http://localhost:3000/`, which
loads Tournament Management (`/tournament-mgmt/`), the pre-tournament launch page.
Event details are managed at `/event-administration/`.
Restart the server after backend changes; refreshing the page alone does not reload server code.

## Multi-Surface Tournament Backend

This branch is being used to document a proposed split of tournament surfaces by
port and operational purpose:

- `3000` Pre-Tournament
- `3001` Day-of Ring Assignment Operations
- `3002` Day-of Monitoring / display-only
- `3003` Day-of Medical
- `3010+` Post-Tournament

The goal is to keep the surfaces loosely coupled while sharing the same server
backend and data model.

Ring layout dimensions are saved in each event's `event-config.json` as numeric
`ringConfigX` (Ring Config Columns, shown as letters) and `ringConfigY` (Ring Config
Rows, shown as numbers) fields (non-negative whole numbers; blank inputs
default to zero). Creating or modifying an event saves both dimensions. Older
`ringConfig` strings such as `"2 x 3"` are read for compatibility and converted to
numeric fields on the next save.

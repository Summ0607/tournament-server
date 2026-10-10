# tournament-server
Tournament Management Server Source

## Event metadata

Start the server with `node group-server.js` and open `http://localhost:3000/`, which
loads Tournament Management (`/tournament-mgmt/`), the pre-tournament launch page.
Event details are managed at `/event-administration/`.
Restart the server after backend changes; refreshing the page alone does not reload server code.

Ring layout dimensions are saved in each event's `event-config.json` as numeric
`ringConfigX` (Ring Config Columns, shown as letters) and `ringConfigY` (Ring Config
Rows, shown as numbers) fields (non-negative whole numbers; blank inputs
default to zero). Creating or modifying an event saves both dimensions. Older
`ringConfig` strings such as `"2 x 3"` are read for compatibility and converted to
numeric fields on the next save.

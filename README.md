# tournament-server
Tournament Management Server Source

## Publishing Android app updates

The Android app and this server remain separate repositories. The server does
**not** read either repository's Gradle files for update versions. Instead, publish
a built APK explicitly; the command extracts its application ID, version name,
and version code using Android SDK `aapt2`, then computes its size and SHA-256.
Only APKs for `com.summ0.tournamentscoringapp` are accepted. No version number is
maintained manually on the server.

1. Build/test the app in `C:\Karate4\tournament-app`. Increment the app version
   before building an update. Keep the same signing key as the installed app;
   Android rejects incompatible signatures. A successful metadata publication
   does not itself verify signing-key compatibility with a tablet.
2. From `C:\Karate4\tournament-server`, publish the resulting APK:

   ```powershell
   npm run publish:app -- --apk "C:\Karate4\tournament-app\app\build\outputs\apk\debug\app-debug.apk" --aapt2 "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\aapt2.exe"
   ```

   Adjust the SDK build-tools version/path for the machine. The command copies
   the APK to staging **before** extracting its version, so a later rebuild
   cannot change the published bytes. Missing tools, invalid APKs, and incorrect
   application IDs fail explicitly without replacing the active release.
3. The command writes ignored runtime data under `app-releases`: immutable
   `<sha256>\tournament-scoring.apk` artifacts and one generated `current.json`
   manifest. The manifest contains schema version, application ID, version name/code,
   filename, byte size, and SHA-256. It switches atomically only after the APK
   is ready. Earlier artifacts remain for in-flight downloads; do not edit the
   manifest or APKs manually. Failed publication leaves the previous active release
   intact. Republish the same valid APK safely if necessary.
4. Restart already-running server processes **once** after installing this server
   code. Subsequent publication changes are picked up without restarting.
   `GET /api/version` and `GET /download-app` both read the current manifest and
   verify the stored APK's size/checksum. The download returns those verified
   bytes, with `X-App-Version-Code` and `X-App-SHA256` headers. Both endpoints
   use `Cache-Control: no-store`; missing/incomplete/corrupted releases return
   **503 with an explicit error**, never version zero or the old root APK.
5. To test the Wi-Fi update, leave tablet **1.44 (45)** installed, publish
   **1.45 (46)**, restart the server processes as above, and check:

   `https://tourn-svr.home.arpa:3443/api/version`

   It should report version code 46/name 1.45. Restart the tablet app without USB,
   accept the update, complete Android's installer prompts, reopen the app, and
   verify **Version 1.45 (46)** on its startup/Server Configuration screen.
   The installed app only offers an update when the published code is higher.

The server does not rebuild or publish on app startup or on every source edit.
The old repository-root `app-debug.apk` is no longer used by `/download-app`.
The app's existing endpoint names and version fields remain compatible.
Publishing while a user checks then downloads can offer a newer release than
the initial check; each response resolves a complete, verified active release.

For a different deployment folder, set the same absolute
`TOURNAMENT_APP_RELEASE_DIR` for both publishing and every server process (or use
publisher `--directory` and configure the server to match). The deployment host
needs only this release folder and Node dependencies; Android SDK tooling and
the app repository are required only on the publishing machine. Copy the complete
release folder when transferring deployments. Keep it OS-write-restricted to
authorized publishers. APKs/manifests are deployment data, not Git source.

Validate with `npm run test:app-release`.

## Local HTTPS and access control

Browser pages and tournament APIs now require HTTPS, sign-in and role permissions.
Tablets use daily ring QR authorization over validated HTTPS; the old user-agent
bypass and all HTTP listeners have been removed. Fixed-IP QR pairing has been
verified on the physical tablet; tablet DNS resolution is not currently available,
so QR codes default to the fixed IP. Use only on the trusted tournament
network; do not expose this installation to untrusted networks.

### Private Root CA and HTTPS setup

From PowerShell in this repository:

```powershell
.\setup-https.ps1
```

This creates `C:\TournamentPrivate` with inheritance disabled and full control only
for the current Windows account, SYSTEM, and local Administrators. Run the server
under that same account. It refuses to modify an existing installation. Inspect
any partial installation after failure; do not delete or overwrite existing keys.
The directory must remain outside the web-served repository.

| Private installation file | Purpose |
| --- | --- |
| `root-ca\root-ca-key.pem` | Root CA signing key; never distribute or load in the server |
| `root-ca\root-ca.pem` | Self-signed Root CA certificate, valid for 10 years |
| `https\root-ca.pem` | Public CA certificate copy for client trust and verification |
| `https\server-key.pem` | Server private key |
| `https\server.pem` | CA-signed server certificate, valid for 397 days |
| `https\server.json` | Explicit listener/account configuration |
| `accounts.db` | Account/session database, created by account setup or HTTPS startup |

The server certificate's SAN covers **DNS `tourn-svr.home.arpa` and IP
`192.168.4.42`**. OpenSSL creates a self-signed CA, then a separate server certificate
signed by that CA, and verifies both names. Setup uses Git for Windows' OpenSSL;
override `-OpenSslPath` if necessary. Private keys are unencrypted on disk and
protected by Windows ACLs; securely back up the CA key offline, not in Git or a
shared folder. The running server uses only the files in `https`, not the CA key.
Setup creates no user/password and **does not install trust, change DNS/firewall
settings, or start a server**.

After certificates exist, create the first administrator from an interactive
terminal (password entry is hidden):

```powershell
npm run accounts -- create --database "C:\TournamentPrivate\accounts.db" --user admin --roles administrator
```

Start one surface, or all three existing desktop surfaces:

```powershell
$env:TOURNAMENT_HTTPS_CONFIG = "C:\TournamentPrivate\https\server.json"
node server-launcher.js
# Or, in a fresh terminal:
.\launch-surfaces.ps1
```

The launcher starts all three server PowerShell windows minimized and opens
**only Tournament Management home** once all three report ready, not the two
progress pages. `-OpenBrowser` remains accepted and is now on by default;
use `-OpenBrowser:$false` to suppress the initial browser launch. Do not append
`-WindowStyle`; minimization is handled inside the launcher.

**Administration → Server Maintenance → Restart all three services** now drains
and restarts the Tournament Management, Monitoring and Administration Progress
services together. Their existing console windows are minimized, and Tournament
Management home opens in the default browser only after all three replacement
processes are ready. Simulations stop and are saved; they do not resume
automatically. Restart remains protected by Administrator authorization, a local
socket source, a restart token and typed `RESTART` confirmation.

The launcher's supervisors coordinate through a per-launch local named pipe with
a random token. A missing/disconnected service disables coordinated restart;
timeouts and browser-launch failures are reported explicitly. Occupied service
ports are checked before any windows launch, to avoid duplicate groups.
Running `node server-launcher.js` alone retains **single-service restart**, clearly
identified in the UI.

**One-time migration:** stop the three old services with Ctrl+C, then run
`.\launch-surfaces.ps1` once. Existing independent launchers cannot acquire a shared
coordinator merely by refreshing the browser or restarting their child server.
After that, use the Administration restart button. Validate with
`npm run test:services` (uses isolated processes, not the live tournament services).

| Surface | Secure entry |
| --- | --- |
| Tournament Management | `https://tourn-svr.home.arpa:3443/tournament-management/` |
| Monitoring | `https://tourn-svr.home.arpa:3445/event-progress/` |
| Administration Progress | `https://tourn-svr.home.arpa:3447/administration-progress/` |

The fixed IP `192.168.4.42` may replace the DNS hostname at the same HTTPS ports.
Legacy HTTP ports **3000, 3002 and 3004 no longer listen**, including for health
checks or redirects. Restart and shutdown drain the HTTPS listener on each surface.
Invalid/missing configured keys, SANs, CA, expired
certificates, account paths, or occupied ports fail startup; there is no silent
HTTP-only fallback. HTTPS requires TLS 1.2 or newer. The configured source login
limit is 50 attempts per direct source per 15 minutes, per surface process, in
addition to persistent per-account throttling. Change it explicitly in the private
configuration if needed.

No trust store is changed automatically. Before using a browser, install **only
the public Root CA certificate** in the appropriate client trusted-root store.
Trust installation is intentionally deferred for this delivery. Do not bypass
certificate warnings, disable validation, or distribute either private key.
`localhost` is not a certificate SAN: use the DNS name or fixed IP for HTTPS.
Server Maintenance requires an Administrator session over the configured HTTPS
DNS/IP address **on the server computer**. The socket source must be loopback or
one of this computer's interface addresses; another LAN computer is still denied.
The restart token and typed confirmation remain required for coordinated restart.

Direct startup requires `TOURNAMENT_HTTPS_CONFIG` and fails before initializing
databases if configuration is absent or invalid. The `-HttpOnly` launcher option
has been removed. The launcher preflights only HTTPS ports 3443, 3445 and 3447,
then starts three minimized windows and opens home after all are ready.
Restart all three services to apply this conversion; refreshing a browser alone
does not stop an already running HTTP listener. Use **Administration → Server
Maintenance → Restart** when the coordinated launcher is running, or stop the
old three services and rerun `.\launch-surfaces.ps1`. Verify
`/api/https-status` reports `legacyHttpEnabled: false` on each HTTPS surface and
TCP ports 3000, 3002 and 3004 are closed. Health checks now use HTTPS only.
Validate with `npm run test:https` and `tests/launchSurfaces.test.ps1`.

### Browser roles and sign-in

Roles apply to **all tournaments** for now. Multiple roles combine permissions;
existing accounts keep their existing roles, and no accounts are automatically
created or promoted.

| Role | Access |
| --- | --- |
| Administrator | All functions, users/settings, global definitions, simulator and local Server Maintenance |
| Event Coordinator | Tournament preparation and day-of functions; Clinic Management (Under Development) |
| Judging Coordinator | Volunteers/types, Ring Judges and judge assignments; Judge Management layout previews |
| Tournament Operator | Ring Assignment (tablet QR authorization), Division Assignments, Head Table and Audience Viewer only |
| Viewer | Read-only Audience Viewer only; not Head Table |

Use **Administration → Users** to assign Event Coordinator or Viewer explicitly;
Event Coordinator is an additional role, not a rename of Tournament Operator.
Clinic Management is a placeholder. Judge Management contains layout previews,
not operational judge management workflows. Global Schools, Ranks and Visual
Definitions editing remains Administrator-only.

Opening a protected page while signed out redirects to `/account/login`; a new
sign-in opens the account's role-based home rather than the previous page. APIs
return 401 when signed out and 403 when a role is insufficient. Server-side method/path permissions
apply even when a hidden control or URL is invoked directly. Unknown API routes
and raw repository files cannot bypass the page/API policy.

Tournament pages show the current identity, Home and Sign out. When a session
expires, a modal reauthentication form keeps the page and its edits in memory,
clears password fields, and requires the original user to resume. Reads may retry
once after sign-in; mutations are **never replayed automatically**. Review and
save again after an expired save. Role changes are reflected in navigation;
revoked workspaces are blocked without discarding drafts. Existing division-draft
storage is unchanged; authentication does not newly persist form drafts/passwords.

Viewer accounts on smart TVs need a compatible HTTPS browser and trust for the
public CA. The standalone Audience Monitor supports **12 hours from sign-in**
without interaction. This read-only allowance never renews access to editable
pages, which retain normal idle/absolute limits. Background refresh is not user
activity, and displays require sign-in again at the 12-hour boundary.
Verify CA installation and sign-in on each actual display.

Tablet requests to `GET /api/version`, `/download-app`, `/api/events/active`,
`/api/rings/config`, `/api/rings/:id/current`, and
`POST /api/rings/:id/{request-group,heartbeat,complete,assistance,assistance/clear}`
now require a daily ring credential over HTTPS. The old `Dalvik/` user-agent
bypass has been removed. Older tablets must install the updated app and scan a
daily ring QR code; browser permissions are unchanged.
`GET /api/health` and `/api/https-status` are public diagnostics. Public frontend
assets contain no credentials; other repository files are blocked.

Certificate renewal must retain the trusted CA, not create a replacement CA on
every renewal. Before the server certificate expires, use the protected CA key
to sign a new server CSR with the same DNS/IP SANs and `serverAuth` usage, verify
the new certificate and matching key, replace the server files during a planned
break, and restart all surface processes. Clients do not need a new trust root
when the same CA signs the renewed certificate.

Validate with `npm run test:https`; tests generate isolated certificates/accounts,
do not install trust, and do not modify tournament data.

### Daily tablet QR authorization

Under **Ring Management**, open **Ring Assignment**, directly above **Division
Assignments**. Administrators, Event Coordinators and Tournament Operators can
display a daily ring QR code, **Print selected ring**, or **Print all rings**.
All-ring printing produces one labeled sheet per configured ring, with tournament,
server-local date, HTTPS address and scanning instructions. If any generation
fails or the tournament/day changes during generation, no partial set is printed;
the error is displayed so the operator can retry. **Division Assignments** remains
the separate workspace for queuing divisions; its ring details also link to the
QR page. Direct access remains available at `/tablet-pairing/`.
Give each ring its code for that day. Codes are stable
across service restarts and may be scanned repeatedly until **midnight using the
laptop's local date/time**. Changing the active tournament also prevents use of
credentials from a different tournament.
The QR page defaults to **Fixed IP (no DNS)**. **DNS name** remains optional
for networks where tablet DNS resolves correctly; both retain HTTPS and
certificate verification.

On app **1.46 (47)** or later, tap **Scan daily ring QR code** and allow camera
access. Scanning authorizes and automatically connects that tablet to the coded
ring, including its current group. No account password or manual ring selection
is needed on the tablet. Another tablet scanning the same code sees a warning;
confirming **Replace previous tablet** immediately revokes the first tablet.
The same tablet can rescan without replacement confirmation. Moving it to
another ring releases its previous authorization.

The QR contains the HTTPS server address, tournament, ring, date and daily token.
It is a reusable daily authorization code: anyone holding it can authorize a
tablet for that ring that day. Distribute it to ring staff rather than publish it
to the audience. The app exchanges it for a separately hashed server credential,
stores that credential privately (excluded from Android backup/device transfer),
and attaches it only to the same HTTPS origin. Ring IDs are enforced server-side;
tablet credentials cannot access browser administration. Credential expiry and
replacement do not discard unsent scores; rescan the same ring's current code
and retry. A loaded division cannot be reassigned to a different ring/tournament.

The external tablet database is `<accountDatabase>.devices`, beside the private
account database. Apply the same Windows directory ACL restrictions. It stores a
persistent signing secret and hashed tablet credentials; never copy it into this
repository or distribute it with an APK. Restart all services after updating to
load enforcement consistently. All production listeners are now HTTPS-only.

Validate with `npm run test:tablets`. For physical testing, install the new APK
over USB, display a test tournament's ring code on the laptop, scan, then verify
the ring identity, group loading, heartbeat and test score submission. Reopen the
app and briefly disconnect/reconnect Wi-Fi; authorization should persist. Verify
replacement and expired-code rejection with test data, not live results.

`backend/accountSessions.js` stores accounts and browser sessions in SQLite at an
explicit absolute path **outside this repository**. Browser access is allowlisted,
but private account/certificate material must still never be placed in the repository.
OS access controls must restrict this database and its containing directory to the
server/setup account; the file-mode hints do not replace Windows ACLs.
Passwords are salted and hashed with scrypt (N=131072, r=8, p=1), default to 10–128
characters, and are never returned in account responses. New accounts, password
resets and local administrator recovery require at least one uppercase letter
(A-Z), lowercase letter (a-z), number (0-9), and special character (punctuation or
symbol). Spaces are allowed but do not count as special characters. Existing
passwords remain valid for sign-in without meeting the new composition rules.

On the first updated startup, the external account database is upgraded once:
the previous default minimum of 15 becomes 10; other saved minimums and all
other settings are retained. The policy revision increases, browser sessions and
login-failure counters are cleared, and the upgrade is audited. Password hashes
and accounts are unchanged. Subsequent startups preserve administrator-selected
minimums, including 15. Restart all services after updating, then sign in again.

Session
tokens are random and only their SHA-256 digests are persisted.

By default, browser sessions expire after 30 minutes without explicit user activity, or
12 hours absolutely. The standalone read-only Audience Monitor instead permits
12 hours from sign-in without interaction. Merely checking a session does not refresh it. Sessions
survive server restarts; concurrent logins are independent and logout revokes only
the selected session. Account disabling always revokes all sessions; password
resets and role changes do so by default. Browser route permissions use current
account roles on every request; tablets use separate daily ring authorization. Trusted local account mutations
record an audit actor and reject stale account revisions.

The Users page keeps routine deployment guidance off the editing screen. Save
confirmation appears in green beside the form actions, and password mismatches
are shown while editing, before submission. Account revisions remain internal
for stale-edit protection rather than appearing in the editor heading.

Per-account login throttling persists across restarts: by default, five failures in fifteen
minutes trigger a five-minute cooldown, including attempts for unknown user IDs.
The account router also applies a source-based limit to login attempts; its
threshold/window is explicitly set in the private HTTPS configuration.

Account policy is persisted in the same private SQLite database. Trusted setup
code can read it with `getPolicy()` and change it with
`changePolicy({revision, policy, actor})`. Saves require the full policy and its
current revision, reject unknown/missing settings, and record the actor. A changed
policy atomically revokes **all browser sessions**, including the saving user's,
and clears previous login counters so the new throttling policy starts consistently.
An unchanged save does neither. Direct store methods are for trusted local code. The account router supplies a
session authorization token, rechecked inside each administration transaction,
and derives the audit actor from that authenticated account.

The editable settings and validation limits are:

| Setting | Default | Allowed |
| --- | --- | --- |
| User ID minimum / maximum | 3 / 64 characters | 3–64; minimum ≤ maximum |
| Password minimum / maximum | 10 / 128 characters | Minimum 10–128, maximum 64–128; minimum ≤ maximum; uppercase, lowercase, number and special character always required for new/reset passwords |
| Browser idle timeout | 30 minutes | 5–120 minutes |
| Absolute session duration | 12 hours | 1–24 hours; at least the idle timeout |
| Failed-login threshold | 5 | 3–10 |
| Failure window | 15 minutes | 1–60 minutes |
| Cooldown | 5 minutes | 1–60 minutes; throttling cannot be disabled |
| Concurrent sessions | Allowed | Allowed or single-session |
| Logout all sessions | Off | On or off |
| Revoke on password reset / role change | On / on | On or off |

Updated identifier bounds apply to new accounts; password bounds apply to new
accounts and password resets. Existing accounts can still log in with their
existing identifiers/passwords. Keeping sessions on a role change does not retain
old roles: session resolution reads current account permissions. Disabling an
account blocks it regardless of revocation settings.

The UI destinations are **Administration → Users** (add, roles,
enable/disable, password reset; no deletion) and **Administration → User Account
Settings**. They require HTTPS and an administrator session. Sign-in is also
available at `/account/login`. Session polling does not extend idle time;
trusted pointer/keyboard activity on account and tournament screens does, at most once per minute.
On session expiry/revocation, the inline sign-in form preserves unsaved account
edits in memory but clears password fields. Navigation warns before discarding
unsaved edits. Drafts/passwords are never saved in browser storage. Stale writes
show an error and retain the draft until the user explicitly reloads.
Account drafts must also be resumed by the original user after an account switch
in another tab. The settings page groups identifier/password rules, session
limits, failed-sign-in protection and revocation options. Email, personal contact
fields, deletion and Remember Me are not implemented. Device authorization and
certificate policies are separate from these account settings.

### Local account setup and administrator recovery

Run these commands from an interactive terminal using the OS account authorized
to manage the private account database. **First restrict the database directory's
Windows ACLs** to the server/setup account and authorized OS administrators.
The commands rely on those OS permissions; they do not require a browser login
or grant OS privileges. Anyone who can modify the database can administer accounts.
Use the exact same external database path for setup, recovery, and future server
integration. There is no default path or password.

Example commands (replace the database path and user IDs for your installation):

```powershell
npm run accounts -- create --database "C:\TournamentPrivate\accounts.db" --user admin --roles administrator
npm run accounts -- create --database "C:\TournamentPrivate\accounts.db" --user coordinator --roles judging-coordinator
npm run accounts -- create --database "C:\TournamentPrivate\accounts.db" --user operator --roles tournament-operator
npm run accounts -- recover-admin --database "C:\TournamentPrivate\accounts.db" --user admin
```

Create the administrator first. Multiple roles can be supplied as a comma-separated
list. Creation initializes the private database if absent; duplicate IDs are
rejected, never overwritten. Passwords are prompted twice without echo (no stars),
preserve spaces, and must satisfy the current saved account policy. Password
arguments, redirected input, and noninteractive terminals are rejected. Ctrl+C
or Ctrl+D cancels password entry; mismatch/cancellation makes no account change.
Passwords are never printed or recorded in audits. Do not place them in command
arguments, scripts, environment variables, or files.

Recovery requires an **existing administrator** and an existing database; it does
not promote another role or silently bootstrap a missing database. It atomically
resets the password, enables the selected administrator, increments its revision,
revokes **all of that account's sessions even if ordinary reset revocation is off**,
clears its login cooldown, and records `administrator-recovered-sessions-revoked`
with the local OS username as actor (`local:<username>`). Other accounts and
sessions remain unchanged. Concurrent account edits abort recovery rather than
overwrite newer changes. Creation records `account-created` with the same actor.
Failures exit nonzero with an explicit error; no recovery web endpoint exists.

These commands do not install certificates, activate live authorization, or
change tournament data. Setup alone therefore does not secure the running server.

### Protected account API (HTTPS only)

`createAccountRouter({store, allowedOrigins, sourceLimit})` in
`backend/accountRoutes.js` is mounted at `/api/account` before global body parsers
and static-file middleware, so its request-size and origin checks run first.
Tournament responses do not enable permissive CORS; the legacy HTTP CORS middleware
has been removed.
`allowedOrigins` must explicitly list canonical HTTPS origins (including ports).
`sourceLimit` requires `{maxAttempts, windowMs}`; no production threshold is
assumed. It counts login attempts across user IDs by the direct socket source,
ignores forwarding headers, and is process-local (reset on server restart).
Per-account cooldowns remain persistent. Reverse-proxy trust is not implemented:
the router requires an actually encrypted socket, not `X-Forwarded-Proto`.

| Method / relative path | Purpose |
| --- | --- |
| `POST /login` | `{userId, password}`; establish a browser session |
| `GET /session` | Current account, deadlines, and CSRF token; no idle refresh |
| `POST /activity` | Explicit user activity with `{}`; refresh idle time only |
| `POST /logout` | `{}`; revoke according to the logout policy |
| `GET /users` | Administrator-only account list |
| `POST /users` | Administrator-only `{userId, password, roles}` |
| `PUT /users/:userId` | Administrator-only `{revision, roles?, enabled?, password?}` |
| `GET /policy` | Administrator-only policy and revision |
| `PUT /policy` | Administrator-only `{revision, policy}` |

The cookie is `__Host-tournament-session`, Secure, HttpOnly, SameSite=Strict,
Path=/, with no Domain and no Remember Me extension beyond the session deadline.
Raw session tokens are not returned in JSON. Fetch session details to obtain a
session-bound CSRF token; send it as `X-CSRF-Token` on authenticated mutations.
Every mutation (including login) requires JSON and an exact same-origin `Origin`
header. The router rejects unexpected hosts/cross-origin requests, does not grant
CORS access, limits request bodies to 8 KB, and rejects unknown body fields.
Treat `/activity` as explicit user interaction, never background polling.
After policy revocation, log in again; after restart, refresh session details to
obtain the current CSRF token. The account UI handles cookie/session expiration without persisting form drafts.

Validate this delivery with `npm run test:accounts`. Tests use isolated temporary
databases and do not create real accounts or modify tournament data. HTTPS API
tests generate temporary test certificates using OpenSSL (Git for Windows'
`C:\Program Files\Git\usr\bin\openssl.exe` by default on Windows, or `openssl`
elsewhere; override with `OPENSSL_PATH`). These certificates are trusted only by
the test client and are deleted afterward; they do not install a CA on any device.

Feature overview for Audience Monitor, Competitor Lookup, and Day-of clocks:
[docs/audience-monitor-lookup.md](docs/audience-monitor-lookup.md).

Rehearsal and developer instructions are maintained separately in the
[Simulator guide](docs/simulator-guide.md).

Tournament Management uses one shared selected-tournament context for Tournament,
Competitors, Import, Divisions, and planned tournament pages. Competitors shows the
selected tournament's full saved roster by default and supports name/TSD ID search,
school, gender, and rank column filters; age remains visible and searchable. Saved division links open the corresponding saved
division without changing the active tournament; Division Assignments and Head Table
remain explicitly scoped to the active tournament.

## Manual Team Management (first delivery)

Expand **Tournament Management → Team Management** for **Teams** and **Settings**.
These pages use the shared selected tournament, never implicitly the active/default
database. Teams are persisted in that event's `tournament.db`.

- Create, edit, or individually delete **Team Sparring (TS)** and **Team Hyung (TH)**
  teams from any registered competitors, regardless of individual discipline
  eligibility. Mixed studios, ages and ranks are allowed.
- Each discipline defaults to **exactly 3 members, single gender**. Tournament-specific
  Settings independently configure Team Sparring and Team Hyung to require 1–50
  members and permit single or mixed gender. Saves that invalidate existing teams
  return an explanation.
- A competitor may belong to only one team **per discipline**, but can join both.
  Membership and team updates are transactional with database uniqueness and
  foreign-key protection. Captain is recomputed from current registration:
  highest normalized rank (TTLD, G10 through G1, CDB, D1 through D10), then
  oldest age, then lowest competitor ID. Unknown ranks/genders and invalid ages
  are explicitly rejected, not guessed. Stale members are reported on load.
- The full-center member picker searches name, ID, age, gender, rank and studio,
  paginates 25 per page, and retains selections through filtering. Unsaved team
  and settings edits are guarded on page/history/tournament navigation.
- All team and settings writes lock after operational use, using the existing
  event configuration lock. Stop tablet activity, then use **Reset run / Return
  to preparation** from Tournament; this preserves teams and team settings.
  Delete all teams before replacing an imported competitor roster; imports are
  blocked while teams exist to prevent dangling memberships.

**Not delivered:** automatic building, Unassigned Competitors workflow, team
divisions, team scoring, simulator integration or bulk deletion. The first two
buttons are disabled. Division always displays **Unassigned** without a link;
team data is never assigned to individual saved divisions.

API: `GET/POST /api/teams`, `PUT/DELETE /api/teams/:id`, and
`PUT /api/teams/settings`, each requiring an explicit `?eventName=…`. Team writes
accept `{name, discipline: "TS"|"TH", memberIds: [numeric IDs]}`; settings accept
`{TS: {teamSize, genderPolicy: "single"|"mixed"}, TH: {teamSize, genderPolicy: "single"|"mixed"}}`.
Settings are independent for each discipline. Existing shared settings are migrated
to both disciplines without changing their values; subsequent edits are independent.
Settings are displayed in stacked Team Sparring and Team Hyung cards, each with
Gender, Team Size, and its own Save button. Each card saves only its discipline
and preserves unsaved edits in the other card. The settings API also accepts
just one discipline key for an independent update.

## Visual Definitions

The default navigation width is 220px; navigation font sizes remain unchanged.
Explicitly saved sidebar widths take precedence over this default.

### Running Results

**Tournament Management → Results** shows read-only category standings for the
selected tournament. Choose **Live tournament** or a saved simulation in **Result
source**, then use **Refresh Results** to reload accepted packets. Sources are
never combined. The latest completed packet per division is counted once.
The page uses current tournament Competition Types, Medal Points and Grand
Champion Categories without changing tablet scores or stored results.
Only individual medals count. Equal point totals are resolved by highest belt
rank (D3 before D2 before D1, CDB before G1, G1 before G2 through G10), then the
lowest numeric portion of the G/D association/member number (not the belt number).
Missing or invalid member numbers follow valid numbers at the same points/rank.
Competitors still equal share a position, displayed alphabetically;
the top five ranks include all remaining tied competitors. Eligible counts cover competitors
in completed packets, not the entire registration roster.
Simulation demographics come from the saved age-only roster and immutable
simulation tournament date. Live eligibility uses stored age on the tournament
date. Missing or stale ages must be corrected rather than defaulted to zero.
Missing required scoring definitions or invalid data produce explicit errors.
`GET /api/tournament-results?eventName=...&source=live` returns standings and available
sources; a simulation run ID selects its isolated results. No results are written.

### Ring Judges

**Tournament Management → Ring Management → Ring Judges** is a selected-tournament
preparation directory. Add/Edit, search, filtered select-all and confirmed
**Delete selected** removes judges only, never volunteers or competitor registrations.
Click a judge's name to open Edit Judge directly in the main workspace,
keeping the navigation panel visible and usable. Add Judge uses the same workspace
to create a validated Judging volunteer and add only that volunteer to Ring Judges.
The form includes tournament-date age, guardian/contact details and First/Second
Choice. Existing manual judges require these details to become linked volunteers
on their next save. Volunteer-derived edits update the source volunteer and judge
together after age/rank/certification validation; stale revisions reject the save.
If the judge-file write fails, the volunteer write is rolled back, with rollback
failures explicitly reported. Competitor-derived judges use the saved registration
rank (read-only in the editor) and tournament-date age for certification checks.
Correct competitor rank through registration. Invalid edits leave the draft open
without saving. In-House scope uses SK/TK age 11+ and Corner age 15+; other scopes
retain existing qualification rules.
When preparation is locked, clicking opens read-only details instead.
Both use a two-column form (one column on narrow screens), with separate First
and Last Name, TSD ID, School and Rank dropdowns, Certification, Judging Notes
and Flagged for Review. School choices come from the shared active school
directory; an existing judge's school is retained even if absent or archived.
Rank choices display names from **5th Gup** through **Pal Dan**, including
**Cho Dan Bo**, while storing canonical codes. Existing combined names remain
readable and are separated for editing; new saves retain both name fields.
Certification uses the shared levels defined in `db/judgeCertification.js`:
Unknown, Uncertified, SK/TK, Corner, Regional (Center) and International.
Judge ranks span G5–D8, and each level from SK/TK up enforces a minimum rank
(SK/TK: G5, Corner and Regional: D1, International: D2). **Clear Review Flag**, beside
Delete, clears selected judges' flags after confirmation and preserves notes.
**Populate Judges from Competitors** adds Dan-ranked competitors (D1–D8)
aged 18+ as judge candidates, and competitors eligible for SK/TK: G5 or higher
at age 16+, or Cho Dan Bo at age 14+, on the tournament date. Their certification
remains Unknown; SK/TK eligibility is noted for verification. Existing linked
competitors or matching case-insensitive Association IDs are skipped; existing
edits are not overwritten. Population does not certify a judge or establish
availability. Missing or stale tournament ages for eligible ranks prevent
population and are reported for correction.

Certification defaults to Unknown. Saved directories with legacy free-text
certification are normalized on load; unrecognized values or rank/certification
mismatches reset to Unknown or flag the judge for review with an explanatory
note. **Flagged for Review** and
review notes capture follow-up observations, not automatic assignment exclusions.
Judges have an editable Priority from 0 to 99, defaulting to 4; the directory can
be filtered by priority. Manual Only is omitted; **Judge Assignments** remains
Planned.
**Populate Judges from Volunteers** includes primary or secondary Judging
volunteers aged 18+ with Dan rank, and SK/TK-certified volunteers meeting the
rank and age rules above. Supplied certification is copied.
Linked volunteer IDs and nonblank Association IDs prevent repeated population;
existing judge edits are not overwritten. Keep a type named **Judging** for this
workflow; if it is renamed or deleted, population reports the missing type.

Judge data persists atomically in each event's `ring-judges.json`, with revision
checks rejecting stale writes. Operational use locks every write until Reset Run;
reading, searching and opening read-only details remain available.
`GET/POST /api/ring-judges`, `PUT /api/ring-judges/:id`,
`POST /api/ring-judges/populate`, `POST /api/ring-judges/delete` and
`POST /api/ring-judges/clear-review` require an
explicit `eventName`. Writes include `revision`; saves include `judge`, deletes
and clear-review include `ids`. No file is written until the first change. Reset Run preserves
the directory alongside other preparation settings.

### Volunteer Management

The Tier 2 **Volunteer Management** group, below Competitors, contains Tier 3
**Volunteers** and **Volunteer Types**. Both support Add/Edit, search, filtered
select-all, confirmed Delete selected, and Reload Saved. Types initially include
Setup, Teardown, Judging and Security. A type referenced as primary or secondary
cannot be deleted until volunteers are reassigned. Primary is required, secondary
is optional and cannot equal primary.

Manual volunteers require First Name, Last Name, age on the tournament date,
School and recognized Rank. Assoc ID may be blank.
Add/Edit offers full-name rank choices from 5th Gup through Chil Dan, including
Cho Dan Bo. Existing saved ranks outside that range remain visible without being
silently changed. First and Second choice list every saved volunteer type;
Second choice also offers None. All form fields are editable while preparation
is unlocked. Save validates age, rank and certification together, retains the
draft on failure and displays the error in the form.
Certification uses the shared
levels (Unknown, Uncertified, SK/TK, Corner, Regional (Center), International);
unrecognized CSV values are stored as Unknown and reported, and saves enforce
each level's minimum rank.
SK/TK certification additionally requires age 16+ at G5 or higher, or age
14+ at Cho Dan Bo, on the tournament date. Judging volunteers with SK/TK
certification can be included in Ring Judges at lower ranks when they meet
those rules.
For tournaments with saved scope **In-House**, SK/TK requires age **11+** and
Corner requires age **15+** on the tournament date. Existing rank requirements
remain unchanged. Volunteer import/edit and Ring Judges population use this scope,
not the tournament name; other tournament scopes retain their existing age rules.
CSV DOB accepts YYYY-MM-DD or MM/DD/YYYY and is converted transiently to
tournament age; DOB is not retained in the volunteer directory.
Contact number accepts international formats and extensions. Parent/guardian name
is required when saving or importing a volunteer under 18; older records without
these fields remain readable and can be completed in Add/Edit.
CSV import requires these headers (order may vary):

```csv
First Name,Last Name,DOB,Assoc ID,School,Rank,Certification,Primary Volunteer Type,Secondary Volunteer Type
Jane,Doe,1990-05-12,D12345,Example School,D2,,Judging,Setup
```

Optional CSV columns: `Parent/Guardian Name`, `Contact Number`, `Gender`, `Email`.
Gender and email are retained in the saved volunteer directory but are not shown
in the volunteer table or editor; editing other fields preserves them.
Omitted optional
columns preserve those values on matching existing records; a supplied blank
clears the value (guardian validation still applies for minors).

The volunteer list has a compact filter bar for studio, rank, first/second
choices and certification. Search matches names, membership numbers and contact
numbers. Changing a filter clears row selections. Age remains in the editor,
not the list. Contact number and volunteer choices appear first in the table.
**Clear filters** resets all filters and search; Reload Saved preserves them.
Changing tournament or switching to Volunteer Types resets them.
**Print filtered list** prints all matching volunteers, not just selected rows,
with tournament name, filter summary, count, name, contact number, both choices
and certification. Guardian details are not printed. Browser printing also
supports Save as PDF. Printing and filtering remain available when preparation
is locked; Volunteer Types has no volunteer report.

Type names match case-insensitively. Imports validate the entire file before
saving; any bad row or duplicate nonblank Assoc ID within the file rejects all
changes. Matching nonblank IDs update existing volunteers, preserving internal
identity. Blank IDs always add, including on repeated imports. Quoted CSV fields
are supported. Maximum file size is 2 MB. Errors report row numbers.

Data is tournament-specific and persists atomically in `volunteers.json` with one
revision covering volunteers and types. Operational use locks every write until
Reset Run, which preserves the directory. Edits made on the Volunteers page do
not automatically update copied judges; editing the linked entry in Ring Judges
loads the current volunteer details and saves both together. Competitor
registrations are never changed by these edits.
`GET/POST /api/volunteers`, `PUT /api/volunteers/:id`,
`POST /api/volunteers/import` (`csv` text), `POST /api/volunteers/delete` (`ids`),
`POST /api/volunteer-types`, `PUT /api/volunteer-types/:id` (`name`), and
`POST /api/volunteer-types/delete` (`ids`) require explicit `eventName`; writes
require `revision`. Volunteer saves include `volunteer`.

### Tournament age and birth-date minimization

Competitor and volunteer imports calculate age on the configured tournament
date, not today's date. Application records retain only `age` and `ageAsOf`.
Manual volunteer entry requests that tournament-date age directly. Grouping,
judge eligibility and results use these saved values; a legitimate age of zero
is distinct from a missing age. Once age-bearing records exist, `age-context.json`
locks the event date. Reset Run does not unlock it; create a new tournament and
import fresh registration data for a different date.

Existing CSV formats remain supported: DOB is input for age calculation, not a
stored field. For a fresh development start, create a tournament and reimport
the original CSV. Original CSV files are not deleted automatically.
Existing browser group drafts containing birth dates are discarded with a notice
when that browser next opens Tournament Management. Reload previously used
browsers. Copies outside application-managed storage, browser/OS caches and
external backups require a separate retention review. Age is still personal
information; minimization alone is not a legal-compliance guarantee.

### Schools

**Administration → Schools** provides a server-wide school directory, with linked
school names for editing and an **Add School** overlay. Fields are School Name,
semicolon-separated Alternate Names, Chief Instructor, and Archived. The initial
directory contains Vaughns Dojang I - Phoenixville (Master David Painter),
Vaughns Dojang II - Spring Valley (Mr. Ryan Clark), and Vaughns Dojang IV - Audubon
(GM Charles Vaughn). Towns are part of School Name, not aliases.

The directory initializes once on first access and persists atomically in the
ignored runtime file `schools.json`. `GET/POST /api/schools` lists/adds schools;
`PUT /api/schools/:id` edits them. Duplicate names are rejected case-insensitively.
Row checkboxes, select-all and **Delete selected** support confirmed permanent
directory deletion via `POST /api/schools/delete` with `{ids}`.
Archiving, deletion and alias edits do not change existing registration data or
stored school names. Automatic alias matching on import is not enabled.
Cancel/Escape confirms before discarding edits; browser unload guards unsaved
school drafts. Save failures retain the draft and display an error.

### Ranks

**Administration → Ranks** is a server-wide reference directory using the supplied
rank names, belt descriptions, alternate names and display weights. **Add Rank**
and linked names open an Add/Edit overlay; selection checkboxes support confirmed
bulk deletion. Higher sort weights display first; these weights do not change
scoring, division eligibility, rank normalization or team captain selection.

The starting order is combined **TTLD** (Tiny Tigers / Little Dragons, weight 120),
separate **TT** (118) and **LD** (117), then **SD**
(Special Dragons / Special Needs, 113), followed by G10–G1, CDB and Dan/title entries. `Gx` identifies Gup number
and `Dx` Dan number. Candidate/Master titles may share the same Dan code. Ko Dan Ja
and Grandmaster have blank codes because the screenshot does not establish a
numeric level; no level is guessed. D10 is accepted for manually added entries.
Separate TT/LD and SD entries do not enable new competitor-import behavior.

The directory initializes once on first access and persists atomically in ignored
`ranks.json`. APIs: `GET/POST /api/ranks`, `PUT /api/ranks/:id`, and
`POST /api/ranks/delete` with `{ids}`. Duplicate names are rejected, but shared
codes are allowed. Cancel/Escape and navigation guard unsaved rank drafts.
Deleting reference entries does not delete or modify live competitor data.

### Competition Settings

**Tournament Management → Competition Settings** contains **Competition Types**,
**Grand Champion Categories**, and **Medal Points**, each scoped to the shared
selected tournament, not the live active pointer. Compact tables provide Add/Edit
overlays and confirmed selected-entry deletion. Unsaved overlays guard tournament
switches, navigation and browser unload.

These settings feed the **read-only Results standings**, but do not change tablet
scoring, import, division assignment or registration. Operational use locks
writes until Reset Run. Competition Types start with H, W, S, B, TS, CH, D and TH;
TS and TH are correctly marked as team competitions. Medal points start at
10 / 8 / 5 / 5 for first, second and the two third-place entries.

Grand Champion defaults include Female/Male Youth (1–17), Adult (18–34) and Senior
(35–110) categories. Gup ranges include G10 through CDB; Black Belt ranges are
D1–D3. TTLD, TT, LD and SD are excluded. Code-based ranges replace screenshot
database IDs; the supported reference range choices currently span G10–G1, CDB,
and D1–D3.

Before first save the API returns starting reference rows without writing event
files. Edits persist atomically in the tournament folder as `competition-types.json`,
`grand-champion-categories.json`, and `medal-points.json`. They survive Reset Run.
API: `GET/POST /api/competition-settings/:kind`,
`PUT /api/competition-settings/:kind/:id`, and
`POST /api/competition-settings/:kind/delete`, all requiring `?eventName=…`.
Writes include the last-read `revision`; stale writes are rejected. Save bodies
use `{revision, row}`, and deletion uses `{revision, ids}`. Reload Saved refreshes
after concurrent-edit errors. Duplicate names (and competition codes) are rejected.

Administration's **Simulator** and **Server Maintenance** navigation entries open
their existing interfaces inside the shared workspace, retaining the navigation
tree and browser history. Their standalone `/simulator/` and `/admin/` URLs remain
available. Embedded copies omit their duplicate banners; leaving the page unloads
the embedded UI and its polling, but does not stop server-side simulation runs.
Restart confirmation and reconnect behavior are unchanged.
The Simulator also adopts the saved font, control, spacing and corner-radius
definitions in both embedded and standalone use. Run overview metrics use compact
cards and body-sized values; run controls share a consistent size and baseline.
Coarse-pointer devices retain at least 44px control targets. Colors and simulator
behavior are unchanged.

**Administration → Visual Definitions** is an editable reference board for colors,
font families and sizes, spacing, control heights, corner radii, sidebar/card widths,
and full-window versus inset layout. Starting values are proposed compact guidelines
based on the reference design, not a claim that every existing page uses them.

Draft changes preview only inside a sandboxed sample frame. Saved **typography,
style and dimensions apply on refresh** to the Tournament Management shell and
its integrated tournament, competitor, division, team and ring-management pages.
Colors remain page-owned and are not applied from the definitions. The Simulator
also adopts typography and dimensions; other standalone tools and tablets are
unchanged. Tournament configuration and operational
behavior are unaffected. Form/card width limits do not cap roster tables or
operational boards, which need the available workspace. Existing mobile navigation,
details panels and division-builder scrolling are preserved.
Color changes are not automatically contrast-certified; review readability before
adopting a palette.

Definitions are server-wide and saved atomically in the ignored runtime file
`visual-definitions.json`. `GET/PUT /api/visual-definitions` exchanges
`{revision, values}`; stale saves are rejected to avoid overwriting another staff
member's edits. Reload Saved confirms before discarding edits. Starting Values
loads a draft only; saving is explicit. Page navigation and browser unload guard
unsaved edits. Read or save failures are reported rather than replaced by defaults.
Presentation loading failures explicitly retain the previous presentation rather
than pretending guidelines were loaded. With no saved file, the API returns the
starting definitions. This adds no authentication; access uses the application's
existing network model.

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
**selected tournament's saved roster**, independently of the active operational
event or unsaved group-builder drafts.

- Enter **at least two characters per term** of name, association/TSD ID, or rank.
  Separate multiple terms with commas for **OR matching**: `Anna, G1` finds
  anyone matching Anna or G1. Terms are trimmed and deduplicated; empty and
  single-character terms are ignored. Each competitor appears only once.
  Case-insensitive literal substring matching finds matches across the roster, sorted
  by last name then first name. Search includes displayed columns, full rank names,
  school, gender, age, division number, contact name, and raw/formatted phone.
  Matches in names, IDs, ranks, and contacts are highlighted.
- Gender, Rank, and School dropdowns (All) sit in their column headings and apply
  immediately, resetting to page one. The toolbar provides Search,
  Per page, and **Filter**. Age remains visible and searchable without range controls.
  Controls wrap on smaller screens. **Filter** or **Enter** applies search and
  filters together with AND; typing alone does not change results or counts.
  Clear the search and select All, then Filter, to restore the full roster.
  A blank search browses the roster without requiring filters.
- **Per page** defaults to **250**, with 25, 50, 100, and 250 choices that
  take effect immediately without applying pending filter edits. Filtering and
  surname sorting run before client-side pagination. Above the table, a summary
  such as **Showing 1–250 of 2,036** accompanies Previous/Next and numbered
  pages; the current page is distinct and large page counts use a bounded window.
  Empty results report **Showing 0–0 of 0**. Applying filters, changing page size,
  sorting, or changing the selected tournament resets to page one. Refresh
  preserves a valid page and clamps it if the roster shrinks.
- An aligned table shows TSD ID, Competitor, Age, Gender, Rank, Studio/School,
  Division, Contact name, and Contact phone. Ranks use saved rank-directory names
  (for example, G6 becomes 6th Gup and D1 becomes Cho Dan); unknown ranks retain
  their saved text. Base rows are 36px high with 12px text, restrained rank chips, highlighted
  matches, subtle alternating backgrounds, and a blue selected-row accent.
  The Competitor heading reverses last-name/first-name sorting.
  Select a result with mouse or keyboard to open the
  details panel containing **first name, last name, parent name, phone, rank,
  studio, and saved group division**. Contact name uses the saved parent/guardian
  name; absent contacts are not inferred. Missing table values show a dash,
  while missing contact/registration details say **Not provided**.
- The selected detail panel has a prominent name, studio, rank badge, and close
  control, followed by Personal Information, Competition Information /
  Assignments, and Notes sections. Email, an explicit age-range value, and
  notes are shown only from existing data; no age range or notes are inferred.
  Missing notes are explicitly indicated. Close or Escape from the details returns focus to search.
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
- Data refreshes every ten seconds or using **Refresh**, retaining a selection
  only while that competitor still matches, even when on another results page.
  Paging, sorting, and page-size changes do not discard matching details.
  Selected tournament context is checked again after loading; a changed/invalid
  tournament or failed roster refresh clears old results and personal details.
  Division lookup failures leave registration searchable without division links.
- Leaving the Competitors view clears loaded lookup results/details. A nonempty search
  without a two-character term clears matches and closes the details panel.
  Tournament changes clear search and filters. The page-level **?** explains the
  toolbar, pagination, and saved division links.

This is a read-only **staff** feature, not a public competitor-contact screen
or part of Audience Monitor. It uses existing roster/division APIs and introduces
no editing actions or data migrations. Refresh the browser to load this UI.
Volunteer Lookup remains future work. Validate with `npm test` and
`git diff --check`.

## Audience Monitor

The simulated Head Table uses the same event-start, estimated tournament
completion, and ring-availability presentation as the live Head Table. Its
estimates come exclusively from the selected simulator run and reflect simulator
speed; paused or unreliable runs show unavailable estimates. Simulation remains
clearly labeled and read-only.

The standalone audience display is available
at **`https://tourn-svr.home.arpa:3443/audience-monitor/`** (or the same path on the
monitoring server at port 3445), with a permitted browser account. Head Table includes an **Audience Monitor**
link that opens a separate tab. Restart the server and refresh to load the
new routes and API. Existing Event Progress routes and surface entry points
remain unchanged.

- A stable **over/under** layout gives approximately 55% of content height to
  **In the Ring**, with **On Deck** below. There is no continuous scrolling.
- The top section shows configured rings in natural ring order, active
  divisions and descriptions, a thin overall-progress bar, and estimated finish.
  Progress is weighted by modeled phase duration, not equal phase segments;
  individual phases and numerical percentages are not shown.
  Paused/disconnected rings show neutral status text without untrusted progress
  or finish predictions. Queued divisions are never presented as active.
- Desktop rows are 80px high, with additional columns on wide screens.
  Two ring columns fit from 1088px of ring-area width (roughly a 1142px browser
  viewport). At intermediate widths, the thin bar moves below division details
  within the same 80px row; wider layouts keep it beside the division.
  Main division text is 30px, ring labels 28px, and times 24px; section headings
  remain 36px and the clock scales up to 40px. Narrow rows use a 112px stacked
  layout. An 1820px-wide, 400px-high ring area fits eight rings without rotation.
- The Audience Monitor trials the saved Visual Definitions palette: page/panel
  backgrounds, text, secondary text, row backgrounds (table headings), primary
  accents/progress, borders, controls, and warnings. Refresh after saving colors.
  Audience font sizes and layout remain unchanged; other pages are not recolored.
  If palette loading fails, a visible notice explains that the built-in dark
  palette remains in use. Viewer accounts may read definitions, not edit them.
- Standalone Audience Monitor sessions permit unattended read-only display for
  **12 hours from sign-in**, without polling or interaction renewing editable
  access. Editable pages retain the configured idle and absolute timeouts.
  The exception covers monitor page/data, palette and simulator-list reads,
  session verification, and sign-out only. Sign-out, disabled accounts, session
  revocation and role permissions still apply. The session cookie is retained
  long enough for the monitor even when editable access has expired.
- The lower section contains **assigned queued divisions only**, with ring,
  division, description, and estimated start in each row. Each ring's next
  division takes priority over later queue entries, then expected start and ring
  determine order within each queue position. Unassigned hypothetical suggestions
  are excluded. Missing predictions say **Not available**.
- Each section calculates its capacity from the available area. It advances
  complete pages every **12 seconds** only when more than one page is needed,
  wraps independently, and shows a page indicator. Live refreshes do not reset
  rotation. Rings retain natural order; existing upcoming rows retain their
  order within each queue position while being read, then re-sort at a rotation
  boundary. Removed rows disappear. Sections stay stationary when all rows fit.
- **Display controls** contains source selection, **Pause pages** (which stops
  rotations without stopping updates), and **Fullscreen**. Page help supports review. The
  layout targets landscape TVs, with a 720px minimum document height; smaller
  windows can scroll the document rather than compressing cards into unreadable
  rows. Browser zoom changes the number of cards that fit.
- Data refreshes every **10 seconds**, with an eight-second request timeout.
  Staleness is checked every second. Refresh failures or expired snapshots hide
  predictions and progression, show an explicit warning, and retry
  automatically. Event changes clear the previous event's rows and reset pages.
  Status and recovery messages remain visible in the header.

### Public display data

`GET /api/rings/monitor` returns a version-1 active-event-only snapshot built
from the same saved groups, authoritative phase definitions, and estimates as
the day-of pages. It uses `Cache-Control: no-store`, rejects an optional
incorrect `eventName` with HTTP 409, checks event switches during loading,
and reports saved-data loading failures with HTTP 500.

The allowlisted response contains event identity/freshness, ring labels,
division numbers/descriptions, audience status, applicable phase progression and
duration-weighted `overallProgress` (0–100 or null),
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

Start the server with the private HTTPS configuration and open `https://tourn-svr.home.arpa:3443/`,
which redirects to the integrated interface at `/tournament-management/`.
The dark, expandable sidebar retains the event banner and existing details panels.
Its hierarchy is:
- **Tournament Management**
  - **Tournament** (existing Event Setup)
  - **Competitors**: direct link to the selected-tournament roster. **Import
    Competitors** is a page action, not a separate sidebar entry.
  - **Volunteer Management** → **Volunteers** / **Volunteer Types**
  - **Divisions** (existing Group Builder, including review and save)
  - **Results** — read-only selected-tournament standings with live/simulation source selection
  - **Team Management** → **Teams** / **Settings** — manual, tournament-scoped
  - **Ring Management**: **Ring Judges** — selected-tournament preparation directory;
    **Judge Assignments** — Planned;
    **Division Assignments** (existing Ring Assignment)
  - **Head Table**
  - **Printing** and **CSV Settings** — Planned
- **Judge Management** → **Judges**, **Testing**, **Eligibility**, **Experience**, **CSV Settings** — layout previews
- **Clinic Management**, **Event History** — Planned
- **Administration**: **Server Maintenance** (`/admin/`) and **Simulator** (`/simulator/`)
- **Your Account** — Planned

Judge Management previews also include Add Judge and Import Judges layouts.
Judge records, filters, saving, importing, sync, and submission-sheet generation
are not implemented; unavailable controls are disabled and no sample records are
shown. Judge email entry and its CSV mapping are explicitly disabled for now.
Add Judge and Import Judges are preview panels within their originating
section rather than separate browser history entries.

Navigation labels omit Planned/Under Development tags; the destination pages
explain their status. Planned destinations expose no operational tools
and do not write tournament data. Navigation uses stable IDs, not display labels.
Section expansion is remembered in browser storage and active-page ancestors
automatically open. Container headings use smaller, blue-tinted uppercase text,
a distinct font treatment, and right-aligned disclosure arrows.
Native disclosure buttons support Tab and Enter/Space;
the current page is marked for assistive technology. At tablet/mobile widths
(960px and below), **Menu** toggles the scrollable sidebar. Escape closes it and
returns focus to Menu; selecting a page closes it and focuses the page heading.
Desktop navigation also scrolls independently for long menus.

Existing direct workflow URLs and standalone tools remain available:
- Tournament / Event Setup: `/tournament-management/?view=event-setup`
- Import (Competitors page action): `/tournament-management/?view=import`
- Divisions / Group Builder: `/tournament-management/?view=groups`
- Division Assignments / Ring Assignment: `/tournament-management/?view=ring-assignment`
- Head Table: `/tournament-management/?view=head-table`
- Competitors (selected-tournament roster): `/tournament-management/?view=competitors`

In-shell navigation supports browser Back/Forward without reloading. While an
import is in progress, page changes and Administration links are blocked;
in-shell history traversal is restored to the importing page until completion.
This does not prevent browser-level reloads, tab closure, or leaving the document
through history outside the shell.

The shared tournament selector scopes Competitors, Import, Divisions, and other
preparation pages. Live pages explicitly reference the active tournament.
Import retains its direct URL and browser history support; Competitors remains
highlighted in the sidebar while importing.

On pre-tournament views the banner describes the **selected event**, including its configured event date
(not today's date) and status: Not active, Active, or Unsaved changes.
No selection and missing dates are labeled explicitly. The separate Active Event
indicator identifies the event used by day-of workflows.
On day-of views the banner switches explicitly to **Active Event** and uses that
event's configured date. Selecting a different event for preparation does not
change the day-of context; activation is available only through the **Active Tournament**
selector on Division Assignments, Head Table, and Judge Assignments.
Ring Judges instead uses the selected preparation tournament and never activates it.
Selecting the current active tournament makes no request and needs no confirmation.
Selecting another asks “Switch live operations to [name]?” and explains that
connected tablets will use the new tournament. Cancel or failed activation preserves
the previous active selection and never changes the preparation selection.
The selector is disabled while activation runs; successful switches clear stale
ring data and reload the current live page. Day-of navigation remains available
without an active tournament so the chooser can be used; no live rings are requested
until a tournament is active. An open
day-of view reports No active event or Unavailable rather than falling back to
the selected event. Division Assignments, Head Table, and competitor lookup
remain integrated; planned Ring Management destinations expose only this activation
selector, not ring-writing actions.
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

**Tournament** opens a **Tournaments** table (Name, Location, Date, Format, Scope,
Status) with **Create Tournament**. Click a name to inspect/edit its settings in
the full center workspace, retaining the banner and navigation; settings do not
use a modal or side details panel. **Save** persists without activating.
Create/edit has no activation or registration-import actions. Use Ring Management's
**Active Tournament** selector for activation and **Import Registration** on
Competitors for import (the internal import URL remains supported).
Activation primes the target tournament's database cache before atomically writing
the active pointer; a priming failure leaves the previous pointer and live cache intact.
The name is the existing folder identity and cannot be renamed after creation.
**Cancel / Back**, navigation, browser history, and tournament switching guard
unsaved edits. Save failures remain visible without discarding the form.

Scope is metadata only: Regional (`regional`), National (`national`), World
(`world`), and In-House (`in-house`). Older tournaments remain **Unspecified**
(`""`); blank is allowed and invalid supplied values are rejected. Scope is
preserved by create/modify/read APIs and archived configuration snapshots; it
does not change judging rules or simulator execution.
Event configuration is authoritative;
operational layout dimensions are derived automatically on creation, saving,
activation, and reading unused event state, including for inactive events.
Layouts support up to 26 letter columns and 50 numbered rows. Zero dimensions
mean no operational rings are configured; no default 1-by-2 layout is substituted.

All event settings (labels, date, scope, format, and layout) become read-only once any
tablet, current/queued/completed assignment, run progress, or result exists.
The lock persists across pauses, disconnects, server restarts, and individual or
full assignment resets. Existing in-use layout mismatches preserve operational
state and are reported in Event Setup; they are never automatically rebuilt.
The legacy ring configuration endpoint cannot independently change event layout,
and submitting identical dimensions preserves all ring state.

To abandon a test run, stop tablet activity, open the tournament's edit workspace, and
choose **Reset run / Return to preparation**. Confirmation archives results,
assignment state, and event configuration under the event's `run-archives`
directory, then clears operational state and unlocks all settings. Competitors,
prepared divisions, saved settings, and the active-event selection are preserved.
Save the new configuration and start again. **Cancel / Back** only leaves the
form; a separate restrained **Delete Tournament** danger zone permanently deletes
the named folder after confirmation. Delete and reset remain available when
settings are locked. The older destructive `/api/events/reset` endpoint remains separate and
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
fully assigned groups emphasize **Go to Division Assignments** when the event
is not already active, rather than highlighting **Save & Finish Setup**.
Editing groups (including drag-and-drop) highlights Save and hides the activation
shortcut until the changes are successfully saved. This opens the live chooser
without activating the browsing tournament. Browser drafts are treated
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

- `3443` Pre-Tournament
- `3444` Ring Assignment Operations (named surface, not launched by default)
- `3445` Event Progress / display-only
- `3446` Medical (named surface, not launched by default)
- `3447` Administration Progress View
- `3453` Post-Tournament (named surface, not launched by default)

All surface ports use HTTPS; the former HTTP port range is retired.

The goal is to keep the surfaces loosely coupled while sharing the same server
backend and data model.

The active surface can be selected with the `TOURNAMENT_SURFACE` environment
variable. If unset, the server defaults to `pre`.
Use `monitoring` for the authenticated Head Table/Event Progress view and `adminProgress` for the
Administration Progress View.
Exact entry points:
- `https://tourn-svr.home.arpa:3445/event-progress/` for the authenticated Event Progress view
- `https://tourn-svr.home.arpa:3447/administration-progress/` for the authenticated Administration Progress view
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

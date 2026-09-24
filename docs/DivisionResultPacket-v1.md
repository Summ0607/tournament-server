# DivisionResultPacket schema v1

The Android scoring client submits one immutable result packet when a ring completes its current group:

```http
POST /api/rings/ring-a-1/complete
Content-Type: application/json
```

The request body follows the machine-readable example in
`reference/fixtures/division-result-packet-v1.sample.json`. The server validates the
schema version, required identity/timestamp fields, ring and active-event identity,
participant references, forms scores, sparring structure, awards, signatures, and
the absence of unresolved `IN_PROGRESS` state.

Accepted packets are stored as JSON records under the active event's
`events/<eventName>/results/` directory. With no active event, the explicit
development fallback is the root `Results/` directory. Each record uses a
server-generated `serverRecordId`; an accepted file is never overwritten.

## Responses

An accepted first submission returns HTTP 200:

```json
{
  "ok": true,
  "status": "accepted",
  "serverRecordId": "result-<uuid>",
  "submissionId": "550e8400-e29b-41d4-a716-446655440000",
  "receivedAt": "2026-09-24T18:00:01.000Z",
  "ringAssignment": { "ringId": "ring-a-1", "currentGroupId": "group-13" }
}
```

The assignment object contains the normal ring response, including the next
queued group when one exists.

The same `submissionId` may be retried safely. The server returns HTTP 200 with
the original acknowledgement and does not write another record or alter ring
state. A different submission for a group that already has an accepted record
returns HTTP 409 with the original receipt metadata. A packet for a group other
than the ring's current group also returns HTTP 409. Structural validation
failures return HTTP 400 with an `errors` array of specific messages.

## Result query endpoints

`GET /api/results` returns summaries for the active event only:

```json
[
  {
    "serverRecordId": "result-<uuid>",
    "submissionId": "550e8400-e29b-41d4-a716-446655440000",
    "groupId": "group-12",
    "groupDivisionNumber": 12,
    "groupName": "G3-G1 Male 10-13",
    "ringId": "ring-a-1",
    "ringLabel": "A1",
    "completedAt": "2026-09-24T18:00:00.000Z",
    "receivedAt": "2026-09-24T18:00:01.000Z",
    "status": "ACCEPTED"
  }
]
```

`GET /api/results/:serverRecordId` returns the complete persisted record,
including `receipt` and the original `packet`. `GET /api/results/group/:groupId`
returns the accepted record history for that group, or HTTP 404 when none exists.

## Manual test plan

1. Create and activate an event, queue a group on a ring, and submit the sample
   packet after changing its `eventName`, `groupId`, and `ringId` to match.
2. Confirm one JSON record exists under the active event's `results` directory,
   the current group is marked complete, and only one queued group advances.
3. Repeat the exact request and confirm HTTP 200, the same `serverRecordId`, and
   unchanged ring state and result-file count.
4. Change only `submissionId` and repeat; confirm HTTP 409 and unchanged state.
5. Submit malformed packets covering a wrong ring, duplicate participant,
   invalid score count, invalid participant reference, `IN_PROGRESS`, and
   invalid sparring warning/outcome; confirm HTTP 400 with specific errors.
6. Switch active events and confirm `/api/results` lists only the selected
   event's records.

## Unresolved contract issue

The server's current rank-code/weapons-eligibility rules do not fully agree with
the Android engine's rank catalog. This milestone intentionally preserves that
disagreement; packet validation does not attempt to reconcile or reinterpret it.

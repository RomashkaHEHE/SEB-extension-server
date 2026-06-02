# Remote Session Contract Update

This file describes the current server behavior that the extension client should
account for on top of the original Remote Session Protocol v1.

## Operator Access

Operator dashboard, REST API, and WebSocket are public. There is no operator auth
and no operator ownership model.

Removed operator concepts:

- `POST /v1/operator/sessions/{sessionId}/claim`
- `assignedOperatorId` as an active workflow signal
- operator-triggered `chat.open`
- operator-triggered `chat.close`
- `requestOpenChat` on operator messages
- `openChat` on `operator.message`

Every website visitor can select any active session and send messages.

## Session Display ID

`POST /v1/extension/sessions` returns a short `displayId` in addition to
`sessionId`.

```json
{
  "sessionId": "uuid",
  "displayId": "0007",
  "extensionToken": "opaque-token",
  "websocketUrl": "wss://urfuseb.ru/v1/extension/ws",
  "screenshotIntervalSeconds": 120,
  "heartbeatIntervalSeconds": 30,
  "serverTime": "2026-06-03T10:00:00.000Z"
}
```

Operator session objects also include `displayId`. The dashboard renders it as
`#0007`.

## Active Sessions Only

`GET /v1/operator/sessions` returns only active sessions by default. Closed,
stale, and offline sessions are not shown in the dashboard.

To inspect a non-active status explicitly, pass `?status=closed`, `?status=stale`,
or `?status=offline`.

## Operator Display Name

Website visitors can set a local display name in the dashboard. The dashboard
sends that name with each operator message.

Operator message request:

```json
{
  "clientMessageId": "uuid",
  "text": "Hello.",
  "operatorDisplayName": "Roman"
}
```

Server response:

```json
{
  "messageId": "uuid",
  "createdAt": "2026-06-03T10:03:00.000Z",
  "deliveryStatus": "queued | delivered"
}
```

WebSocket event delivered to the extension:

```json
{
  "type": "operator.message",
  "messageId": "uuid",
  "operatorId": "operator",
  "operatorDisplayName": "Roman",
  "text": "Hello.",
  "createdAt": "2026-06-03T10:03:00.000Z"
}
```

The extension should display `operatorDisplayName` when present and fall back to a
generic operator label when it is missing.

## Supported Operator Commands

The only supported operator command is:

- `screenshot.capture_now`

`chat.open` and `chat.close` are intentionally unsupported.

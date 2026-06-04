# Remote Session Contract

Status: implemented on the server/operator site.
Audience: SEB Helper Pro extension agent.

This contract covers the base remote session protocol: session registration,
heartbeat, screenshots, chat, commands, and session close. Moodle question
transfer, SOS, and extension release upload are separate contracts in this
folder.

## Base URLs

Production HTTP base:

```text
https://urfuseb.ru
```

Production WebSocket endpoint:

```text
wss://urfuseb.ru/v1/extension/ws
```

## Session Registration

Create a new remote session when the extension starts a remote run:

```http
POST /v1/extension/sessions
Content-Type: application/json
```

Request body:

```json
{
  "installId": "stable-extension-install-id",
  "extensionVersion": "0.4.0",
  "configHash": "optional-config-hash",
  "startUrl": "https://exam.example/mod/quiz/attempt.php?attempt=42",
  "domain": "exam.example",
  "userLabel": "Student display name",
  "capabilities": [
    "chat",
    "screenshots",
    "screenshot.capture_now",
    "MOODLE_CONTRACT_IMPLEMENTED",
    "sos.hotkey"
  ]
}
```

Response `201`:

```json
{
  "sessionId": "server-session-id",
  "displayId": "0001",
  "extensionToken": "server-generated-token",
  "websocketUrl": "wss://urfuseb.ru/v1/extension/ws",
  "screenshotIntervalSeconds": 120,
  "heartbeatIntervalSeconds": 30,
  "serverTime": "2026-06-04T00:00:00.000Z"
}
```

The extension MUST store `sessionId`, `displayId`, and `extensionToken` for the
current run. All extension REST calls after registration require:

```http
Authorization: Bearer <extensionToken>
```

If the extension loses the token, it should create a new session.

## WebSocket Attachment

Connect to:

```text
wss://urfuseb.ru/v1/extension/ws?sessionId=<sessionId>
```

Browser WebSocket clients usually cannot set an `Authorization` header. In that
case, send `extension.hello` immediately after opening the socket:

```json
{
  "type": "extension.hello",
  "sessionId": "server-session-id",
  "extensionToken": "server-generated-token",
  "capabilities": ["chat", "MOODLE_CONTRACT_IMPLEMENTED", "sos.hotkey"]
}
```

The server closes the socket if it does not receive a valid hello within 5
seconds. After a valid attach, the server sends:

```json
{
  "type": "server.hello",
  "sessionId": "server-session-id",
  "serverTime": "2026-06-04T00:00:00.000Z"
}
```

The extension may send:

```json
{
  "type": "extension.ping"
}
```

The server answers:

```json
{
  "type": "server.pong",
  "serverTime": "2026-06-04T00:00:00.000Z"
}
```

## Heartbeat

Send heartbeat roughly every `heartbeatIntervalSeconds`:

```http
PATCH /v1/extension/sessions/:sessionId/heartbeat
Authorization: Bearer <extensionToken>
Content-Type: application/json
```

Request body:

```json
{
  "currentUrl": "https://exam.example/mod/quiz/attempt.php?attempt=42&page=2",
  "lastScreenshotAt": "2026-06-04T00:01:30.000Z",
  "chatOpen": false
}
```

`chatOpen` is legacy telemetry only. Operators cannot open or close the
extension chat from the site.

Response `200`:

```json
{
  "status": "ok",
  "serverTime": "2026-06-04T00:01:30.000Z"
}
```

## Screenshot Upload

Upload the latest page screenshot roughly every `screenshotIntervalSeconds` and
also after page changes when practical:

```http
POST /v1/extension/sessions/:sessionId/screenshots
Authorization: Bearer <extensionToken>
Content-Type: multipart/form-data
```

Multipart fields:

- `image`: required JPEG or PNG file field.
- `capturedAt`: optional ISO timestamp from the client.
- `currentUrl`: optional current page URL.
- `width`: optional screenshot width in pixels.
- `height`: optional screenshot height in pixels.
- `captureMethod`: optional client diagnostic string.

Response `201`:

```json
{
  "screenshotId": "server-screenshot-id",
  "receivedAt": "2026-06-04T00:02:00.000Z"
}
```

The default server upload limit is 8 MiB.

## Chat

Operator messages are delivered to the extension over the extension WebSocket:

```json
{
  "type": "operator.message",
  "messageId": "server-message-id",
  "clientMessageId": "optional-client-message-id",
  "operatorId": "operator",
  "operatorDisplayName": "Roman",
  "text": "Message text",
  "createdAt": "2026-06-04T00:03:00.000Z"
}
```

The extension should display `operatorDisplayName` when it is present.

Extension chat messages should be sent over the same WebSocket:

```json
{
  "type": "chat.message",
  "clientMessageId": "extension-generated-id",
  "text": "Message text",
  "createdAt": "2026-06-04T00:03:10.000Z"
}
```

The server trims whitespace and rejects empty messages.

## Commands

The server can send commands to the extension:

```json
{
  "type": "session.command",
  "commandId": "server-command-id",
  "name": "screenshot.capture_now",
  "payload": {}
}
```

Supported commands:

- `screenshot.capture_now`: capture and upload a fresh screenshot immediately.

After handling a command, the extension should respond:

```json
{
  "type": "command.result",
  "commandId": "server-command-id",
  "status": "ok",
  "payload": {
    "screenshotId": "server-screenshot-id"
  }
}
```

On failure:

```json
{
  "type": "command.result",
  "commandId": "server-command-id",
  "status": "error",
  "error": {
    "code": "capture_failed",
    "message": "Could not capture the active tab"
  },
  "payload": null
}
```

## Close Session

When the remote run ends, close the session if possible:

```http
PATCH /v1/extension/sessions/:sessionId/close
Authorization: Bearer <extensionToken>
Content-Type: application/json
```

Request body:

```json
{
  "reason": "extension_stopped"
}
```

Response `200`:

```json
{
  "status": "closed",
  "closedAt": "2026-06-04T00:05:00.000Z"
}
```

The operator site only shows active sessions by default, so closed sessions
disappear from the session tab row.

## Error Shape

REST errors use:

```json
{
  "error": {
    "code": "invalid_token",
    "message": "Extension token is invalid"
  }
}
```

Common errors:

- `401 invalid_token`: missing or wrong extension token.
- `404 session_not_found`: unknown session id.
- `409 session_closed`: session was already closed.
- `413 payload_too_large`: uploaded screenshot is too large.
- `415 unsupported_image_type`: screenshot is not JPEG or PNG.

WebSocket errors use:

```json
{
  "type": "server.error",
  "error": {
    "code": "unsupported_message",
    "message": "Message type is not supported"
  }
}
```

## Related Contracts

- `MOODLE_QUESTION_CONTRACT.md`: Moodle question snapshots and answer delivery.
- `REMOTE_SOS_CONTRACT.md`: SOS hotkey signal.
- `EXTENSION_RELEASE_UPLOAD_CONTRACT.md`: private release ZIP upload to server.

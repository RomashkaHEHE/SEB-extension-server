# Remote SOS Contract

Status: implemented on the server.

This contract covers the SOS signal sent by the extension and the operator-side
state shown on the site. Moodle transfer is independent from SOS. If the
extension sends `MOODLE_CONTRACT_IMPLEMENTED` in `capabilities`, the server keeps
it as a plain capability string and does not require extra handling for SOS.

## Extension Capabilities

When creating a session or sending `extension.hello`, the extension SHOULD include:

```json
{
  "capabilities": ["chat", "sos.hotkey"]
}
```

`sos.hotkey` means the extension can send the emergency signal. Current client
hotkey: `Ctrl+Shift+4`.

## Send SOS

`POST /v1/extension/sessions/:sessionId/sos`

Headers:

```http
Authorization: Bearer <extensionToken>
Content-Type: application/json
```

Request body:

```json
{
  "clientSignalId": "random-client-id",
  "sentAt": "2026-06-04T08:15:00.000Z",
  "trigger": "hotkey",
  "source": "extension",
  "hotkey": {
    "label": "Ctrl+Shift+4",
    "code": "Digit4",
    "key": "4",
    "ctrlKey": true,
    "shiftKey": true,
    "altKey": false,
    "metaKey": false
  },
  "currentUrl": "https://exam.example/mod/quiz/attempt.php?attempt=42",
  "pageTitle": "Quiz attempt",
  "displayId": "0001",
  "extensionVersion": "0.4.0"
}
```

Field notes:

- `clientSignalId`: client idempotency/debug id. The server stores it and returns it.
- `sentAt`: client-side send time. If absent, server uses receive time.
- `trigger`: currently `hotkey`.
- `source`: currently `extension`.
- `hotkey`: optional metadata for diagnostics/UI.
- `currentUrl`: if present, also updates the session current URL.

Response `201`:

```json
{
  "sosId": "server-id",
  "clientSignalId": "random-client-id",
  "active": true,
  "receivedAt": "2026-06-04T08:15:01.000Z"
}
```

## Server Behavior

After a valid SOS request the server:

- sets `session.sosActive = true`;
- stores `session.sos` with the SOS metadata;
- highlights and blinks the session on the operator dashboard;
- shows `Turn off SOS` inside the selected session;
- appends a system chat message visible to operators.

Operator session objects now include:

```json
{
  "sosActive": true,
  "sos": {
    "sosId": "server-id",
    "clientSignalId": "random-client-id",
    "active": true,
    "sentAt": "2026-06-04T08:15:00.000Z",
    "receivedAt": "2026-06-04T08:15:01.000Z",
    "clearedAt": null,
    "trigger": "hotkey",
    "source": "extension",
    "currentUrl": "https://exam.example/mod/quiz/attempt.php?attempt=42",
    "pageTitle": "Quiz attempt",
    "displayId": "0001",
    "extensionVersion": "0.4.0",
    "hotkey": {
      "label": "Ctrl+Shift+4",
      "code": "Digit4",
      "key": "4",
      "ctrlKey": true,
      "shiftKey": true,
      "altKey": false,
      "metaKey": false
    },
    "clearedByDisplayName": ""
  }
}
```

## Operator WebSocket Events

The server broadcasts the usual `session.upsert`, plus:

```json
{
  "type": "session.sos",
  "sessionId": "session-id",
  "sos": {
    "sosId": "server-id",
    "clientSignalId": "random-client-id",
    "active": true
  }
}
```

And a chat system message:

```json
{
  "type": "chat.message",
  "sessionId": "session-id",
  "messageId": "message-id",
  "clientMessageId": "sos:random-client-id",
  "sender": "system",
  "systemEvent": "sos.triggered",
  "text": "SOS signal was pressed",
  "createdAt": "2026-06-04T08:15:01.000Z",
  "sosId": "server-id",
  "trigger": "hotkey",
  "source": "extension",
  "currentUrl": "https://exam.example/mod/quiz/attempt.php?attempt=42"
}
```

This chat message is operator-facing. The extension does not need to consume it.

## Clear SOS

Clearing SOS is operator-side only.

`POST /v1/operator/sessions/:sessionId/sos/clear`

Request body:

```json
{
  "operatorDisplayName": "Roman"
}
```

Response `200`:

```json
{
  "session": {
    "sessionId": "session-id",
    "sosActive": false
  },
  "sos": {
    "sosId": "server-id",
    "active": false,
    "clearedAt": "2026-06-04T08:16:00.000Z",
    "clearedByDisplayName": "Roman"
  }
}
```

The server broadcasts:

```json
{
  "type": "session.sos.cleared",
  "sessionId": "session-id",
  "sos": {
    "sosId": "server-id",
    "active": false
  }
}
```

And appends another system chat message:

```json
{
  "type": "chat.message",
  "sender": "system",
  "systemEvent": "sos.cleared",
  "text": "SOS signal was turned off",
  "sosId": "server-id"
}
```

# Moodle Question Contract

Status: implemented on the server/operator site.  
Audience: SEB Helper Pro extension agent.

The operator site renders the current Moodle question, lets an operator fill the
same controls, and sends the answer back to the extension. The extension applies
that answer on the original Moodle page when the user presses `Ctrl+Shift+2`.

## Current Question Model

The server keeps only the current Moodle question for a session. When the
extension sends a new question snapshot, it replaces the previous question for
that session on the operator site. Old questions should not be shown.

Send a fresh snapshot whenever the current Moodle question changes:

- quiz page navigation;
- question slot/page changes;
- Moodle dynamically re-renders the question;
- a different question becomes visible/current.

Endpoint:

```http
POST /v1/extension/sessions/:sessionId/moodle/questions
Authorization: Bearer <extensionToken>
Content-Type: application/json
```

Request body:

```json
{
  "clientQuestionId": "attempt-786072-slot-6",
  "status": "open",
  "pageUrl": "https://exam2.urfu.ru/mod/quiz/attempt.php?attempt=786072&cmid=645&page=5",
  "baseUrl": "https://exam2.urfu.ru/mod/quiz/",
  "attemptId": "786072",
  "cmid": "645",
  "slot": "6",
  "questionNumber": "6",
  "questionType": "ddwtos",
  "questionState": "",
  "questionFingerprint": "q910995:6",
  "title": "Question 6",
  "text": "Plain-text fallback",
  "html": "<div id=\"question-910995-6\" class=\"que ddwtos\">...</div>",
  "controls": [],
  "moodle": {
    "version": "2023100902",
    "theme": "classic"
  }
}
```

Server limits:

- `html`: up to 900000 chars.
- `text`: up to 20000 chars.
- `controls`: up to 400 controls, each with up to 200 options.

Response:

```json
{
  "questionId": "server-question-id",
  "clientQuestionId": "attempt-786072-slot-6",
  "receivedAt": "2026-06-04T00:00:00.000Z",
  "updatedAt": "2026-06-04T00:00:00.000Z"
}
```

## HTML Snapshot Requirements

Prefer raw, question-local Moodle HTML over a simplified reconstruction.

Include:

- the root `.que` node for the current question;
- `.info`, `.content`, `.formulation`, `.qtext`, `.answer`, `.ablock`;
- all answer controls: `input`, `select`, `textarea`;
- hidden Moodle inputs related to answer state;
- ids, names, classes, `data-*` attributes, and inline dimensions;
- drag/drop classes and attributes, especially `.drag`, `.dragitem`,
  `.draggable`, `.drop`, `.dropzone`, `.place`, `data-dragid`, `data-choice`,
  `data-value`, `data-place`;
- media/player HTML if Moodle rendered it. The server strips unsupported audio
  players and turns them into a placeholder.

Do not strip hidden inputs around drag/drop zones. They are the best way for the
operator site to return a normal field value instead of a fallback `dragdrop`
field.

## Controls Fallback

`controls` is optional when the raw HTML contains usable fields, but it is useful
as a fallback. Control shape:

```json
{
  "controlId": "q910995:6_sub0",
  "name": "q910995:6_sub0",
  "id": "q910995:6_sub0",
  "selector": "#q910995\\:6_sub0",
  "type": "select",
  "label": "Surname",
  "labelHtml": "Surname",
  "value": "",
  "checked": false,
  "multiple": false,
  "disabled": false,
  "required": false,
  "options": [
    {
      "value": "1",
      "label": "A",
      "html": "A",
      "selected": false,
      "checked": false,
      "disabled": false
    }
  ]
}
```

Supported control types include `text`, `textarea`, `number`, `select`,
`select-one`, `select-multiple`, `radio`, and `checkbox`.

## Audio Policy

The operator site does not support audio playback.

The extension does not need to proxy, upload, or play audio. It should simply
include the Moodle-rendered media/player HTML in `html` if it exists. The server
will replace Moodle/MediaElement/VideoJS audio player markup with a non-playable
placeholder such as:

```text
Audio recording - 1:58
Playback is not available on this site.
```

If the extension can preserve visible duration text such as `Duration 1:58` or
`Продолжительность 1:58`, the server can display the duration. If no duration is
available, the placeholder will omit it.

Do not implement an audio player on the extension side for the operator site.

## Operator Answer Delivery

When the operator clicks `Send answers`, the server sends this message over the
extension websocket:

```json
{
  "type": "moodle.answer",
  "answerId": "server-answer-id",
  "questionId": "server-question-id",
  "clientQuestionId": "attempt-786072-slot-6",
  "questionFingerprint": "q910995:6",
  "applyMode": "on_hotkey",
  "hotkey": {
    "label": "Ctrl+Shift+2",
    "ctrlKey": true,
    "shiftKey": true,
    "altKey": false,
    "metaKey": false,
    "key": "2",
    "code": "Digit2"
  },
  "fields": [
    {
      "controlId": "q910995:6_sub0",
      "name": "q910995:6_sub0",
      "id": "q910995:6_sub0",
      "selector": "#q910995\\:6_sub0",
      "type": "select",
      "value": "1",
      "values": [],
      "text": "",
      "checked": null
    }
  ],
  "submit": false,
  "operatorDisplayName": "Roman",
  "createdAt": "2026-06-04T00:00:00.000Z"
}
```

`applyMode` is currently always `on_hotkey`. The extension should store the
latest delivered answer and apply it only after the user presses `Ctrl+Shift+2`
on the Moodle page.

If the extension reconnects, the server may redeliver queued/delivered answers
that are not completed. Use `answerId` for idempotency.

## Normal Field Application

For each `field`:

1. Resolve target by `selector`, then `id`, then `name`, then `controlId`.
2. Ignore disabled targets.
3. Apply by type:
   - `radio`: check the radio with matching `value`.
   - `checkbox`: set `checked`.
   - `select` / `select-one`: set `value`.
   - `select-multiple`: select `values` if present, otherwise `value`.
   - text-like inputs and `textarea`: set `value`.
   - hidden inputs: set `value`.
4. Dispatch bubbling `input` and `change` events after mutation.

If `submit` is true in a future message, submit the Moodle form after applying
fields. It is currently false from the operator site.

## Drag/Drop Field Application

The operator site supports dragging cards inside the rendered iframe. If it can
update a real Moodle hidden/input field, the server will send that field as a
normal `input` field. The extension should handle it with the normal field
algorithm above.

If there is no real field in the snapshot, the server can send a fallback field:

```json
{
  "controlId": "",
  "name": "drop-1",
  "id": "drop-1",
  "selector": "#drop-1",
  "type": "dragdrop",
  "value": "2",
  "values": [],
  "text": "Address",
  "checked": null
}
```

For `type: "dragdrop"`, the extension should:

1. Try to resolve `selector` / `id` / `name` to an input/select/textarea. If
   found, set `value` and dispatch `input`/`change`.
2. If it resolves to a drop zone, find its related Moodle hidden input:
   - descendant `input[name]`;
   - `data-inputname`, `data-fieldname`, or `data-name`;
   - `data-place` or an id ending in a place number, mapped to names like
     `*_pN` or `*[N]`.
3. If a related hidden input is found, set it to `value` and dispatch
   `input`/`change`.
4. If no hidden input is found, locate the source card by:
   - `data-dragid`, `data-choice`, `data-value`, `value`;
   - id suffix matching `value`;
   - visible text matching `text`.
5. Simulate Moodle-compatible drag/drop or click-to-place from that card into
   the drop zone, then dispatch `input`/`change` on affected fields.

The extension should make this operation idempotent. Reapplying the same answer
should not duplicate a card or corrupt the question.

## Answer Result

After applying an answer, send a websocket message back:

```json
{
  "type": "moodle.answer.result",
  "questionId": "server-question-id",
  "answerId": "server-answer-id",
  "status": "ok",
  "payload": {
    "appliedFieldCount": 3
  }
}
```

On failure:

```json
{
  "type": "moodle.answer.result",
  "questionId": "server-question-id",
  "answerId": "server-answer-id",
  "status": "error",
  "error": {
    "code": "field_not_found",
    "message": "Could not resolve q910995:6_sub0"
  },
  "payload": {
    "appliedFieldCount": 2
  }
}
```

The server forwards this result to operator dashboards.

## Minimal Extension Checklist

- Send the current question snapshot to
  `POST /v1/extension/sessions/:sessionId/moodle/questions`.
- Preserve raw Moodle HTML, hidden inputs, classes, ids, and `data-*`.
- Do not implement audio playback for the operator site.
- Keep enough audio/player text for the server to infer duration when possible.
- Store incoming `moodle.answer` messages by `answerId`.
- Apply the latest pending answer on `Ctrl+Shift+2`.
- Support `type: "dragdrop"` fallback fields.
- Send `moodle.answer.result` after applying.

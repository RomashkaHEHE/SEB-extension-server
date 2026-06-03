# Moodle Question Transfer Contract

Protocol version: `moodle-question-v1`.

This contract lets the extension publish a rendered Moodle quiz question to the
server, lets the operator fill the mirrored controls on the server dashboard, and
delivers the answer payload back to the extension. The extension must apply the
payload to the real Moodle page only when the user presses `Ctrl+Shift+2`.

## Moodle Detection

The extension should treat a page as a Moodle quiz attempt when the page has
Moodle globals or quiz markup such as:

- `window.M && M.cfg`
- `body.path-mod.path-mod-quiz`
- `#responseform`
- visible question wrappers matching `.que`

In the captured URFU logs the server is Moodle `2023100902` with theme
`classic`, and question wrappers look like `div.que.<qtype>`. Moodle developer
docs describe `formulation_and_controls` as the renderer area containing the
question text and student answer controls, and Moodle question type docs list
standard qtypes such as `multichoice`, `match`, `multianswer`, `essay`,
`shortanswer`, `numerical`, `truefalse`, `ddwtos`, `ddmarker`, `ddimageortext`,
`gapselect`, and `ordering`.

Useful primary references:

- https://docs.moodle.org/502/en/Question_types
- https://docs.moodle.org/dev/Question_types
- https://phpdoc.moodledev.io/main/db/db0/classqtype__renderer.html
- https://jsdoc.moodledev.io/main/module-qtype_ddwtos_ddwtos.html

## Extension Capabilities

Include these capabilities when creating or attaching to a remote session:

```json
{
  "capabilities": [
    "moodle.question_snapshot",
    "moodle.answer_hotkey"
  ]
}
```

## Publish Question Snapshot

`POST /v1/extension/sessions/:sessionId/moodle/questions`

Headers:

- `Authorization: Bearer <extensionToken>`
- `Content-Type: application/json`

Body:

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
  "questionType": "match",
  "questionState": "notyetanswered",
  "questionFingerprint": "q910995:6",
  "title": "Question 6",
  "text": "Plain text fallback",
  "html": "<div id=\"question-910995-6\" class=\"que match\">...</div>",
  "controls": [
    {
      "controlId": "q910995:6_sub0",
      "name": "q910995:6_sub0",
      "id": "q910995:6_sub0",
      "selector": "#q910995\\:6_sub0",
      "type": "select",
      "label": "Question 1",
      "value": "",
      "checked": false,
      "multiple": false,
      "disabled": false,
      "required": false,
      "options": [
        { "value": "", "label": "" },
        { "value": "1", "label": "A" }
      ]
    }
  ],
  "moodle": {
    "version": "2023100902",
    "theme": "classic",
    "language": "ru",
    "courseId": "33",
    "contextId": "39164",
    "jsrev": "1779656524"
  }
}
```

Response `201` for a new snapshot or `200` for an upsert by
`clientQuestionId`:

```json
{
  "questionId": "uuid",
  "clientQuestionId": "attempt-786072-slot-6",
  "receivedAt": "2026-06-03T10:00:00.000Z",
  "updatedAt": "2026-06-03T10:00:00.000Z"
}
```

Snapshot rules for the extension:

- Send one visible `.que` question per snapshot. If Moodle shows several
  questions on one page, send several snapshots.
- `html` should be the question wrapper or a compact container that includes the
  exact visible formulation and controls. Do not send the whole Moodle page.
- Make asset URLs absolute, or set `baseUrl`.
- Include all answer controls in `controls`, including hidden answer fields used
  by drag/drop qtypes. Exclude Moodle housekeeping fields such as `sesskey`,
  `attempt`, `slots`, `:sequencecheck`, and `:flagged`.
- `clientQuestionId` should be stable for the same attempt and slot. Recommended:
  `attempt-<attemptId>-slot-<slot>`.

## Operator Reads Questions

`GET /v1/operator/sessions/:sessionId/moodle/questions`

Returns newest first:

```json
{
  "questions": [
    {
      "questionId": "uuid",
      "clientQuestionId": "attempt-786072-slot-6",
      "sessionId": "uuid",
      "status": "open",
      "pageUrl": "...",
      "baseUrl": "...",
      "attemptId": "786072",
      "cmid": "645",
      "slot": "6",
      "questionNumber": "6",
      "questionType": "match",
      "questionState": "notyetanswered",
      "questionFingerprint": "q910995:6",
      "html": "...",
      "controls": [],
      "moodle": {},
      "receivedAt": "...",
      "updatedAt": "...",
      "latestAnswer": null
    }
  ]
}
```

`GET /v1/operator/sessions/:sessionId/moodle/questions/:questionId` returns one
question object.

## Operator Sends Answers

`POST /v1/operator/sessions/:sessionId/moodle/questions/:questionId/answers`

Body:

```json
{
  "operatorDisplayName": "Roman",
  "submit": false,
  "fields": [
    {
      "controlId": "q910995:6_sub0",
      "name": "q910995:6_sub0",
      "id": "q910995:6_sub0",
      "selector": "#q910995\\:6_sub0",
      "type": "select",
      "value": "1",
      "values": [],
      "checked": null
    }
  ]
}
```

Response:

```json
{
  "answerId": "uuid",
  "questionId": "uuid",
  "deliveryStatus": "delivered",
  "hotkey": {
    "label": "Ctrl+Shift+2",
    "ctrlKey": true,
    "shiftKey": true,
    "altKey": false,
    "metaKey": false,
    "key": "2",
    "code": "Digit2"
  },
  "createdAt": "2026-06-03T10:01:00.000Z"
}
```

## Extension WebSocket

Server sends this to the extension:

```json
{
  "type": "moodle.answer",
  "answerId": "uuid",
  "questionId": "uuid",
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
  "fields": [],
  "submit": false,
  "operatorDisplayName": "Roman",
  "createdAt": "2026-06-03T10:01:00.000Z"
}
```

Extension behavior:

- Store the latest `moodle.answer` as pending for the matching question.
- Do not fill Moodle immediately.
- On `Ctrl+Shift+2`, find the real question by `clientQuestionId`,
  `questionFingerprint`, slot, exact `name`, `id`, or `selector`.
- Apply each field:
  - `text`, `textarea`, `hidden`: set `.value`.
  - `select`: set `.value`.
  - `radio`: select the radio with the same `name` and `value`.
  - `checkbox`: set `.checked` from `checked`.
  - drag/drop/card qtypes: set the qtype hidden field values from `value` or
    `values`, then refresh visible Moodle UI if that qtype exposes a JS helper.
- Dispatch `input` and `change` events after each write.
- Do not submit the quiz unless `submit === true`.

Then extension sends:

```json
{
  "type": "moodle.answer.result",
  "questionId": "uuid",
  "answerId": "uuid",
  "status": "ok",
  "payload": {
    "appliedFieldCount": 1
  }
}
```

Error result:

```json
{
  "type": "moodle.answer.result",
  "questionId": "uuid",
  "answerId": "uuid",
  "status": "error",
  "error": {
    "code": "question_not_found",
    "message": "Matching Moodle question was not found on the current page"
  }
}
```

## Operator WebSocket

Server broadcasts:

```json
{
  "type": "moodle.question.upsert",
  "sessionId": "uuid",
  "question": {}
}
```

```json
{
  "type": "moodle.answer.submitted",
  "sessionId": "uuid",
  "questionId": "uuid",
  "answerId": "uuid",
  "deliveryStatus": "delivered",
  "createdAt": "2026-06-03T10:01:00.000Z"
}
```

```json
{
  "type": "moodle.answer.result",
  "sessionId": "uuid",
  "questionId": "uuid",
  "answerId": "uuid",
  "status": "ok",
  "payload": {},
  "error": null,
  "receivedAt": "2026-06-03T10:01:10.000Z"
}
```

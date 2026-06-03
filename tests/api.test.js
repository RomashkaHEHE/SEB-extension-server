const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const { createService } = require("../src/server");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForJson(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 1000);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString("utf8"));
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }

    socket.on("message", onMessage);
  });
}

test("remote session lifecycle stores and exposes latest screenshot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seb-server-"));
  const service = createService({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    operatorApiToken: "operator-test-token",
    publicBaseUrl: ""
  });
  const baseUrl = await listen(service.server);

  try {
    const createResponse = await fetch(`${baseUrl}/v1/extension/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: "install-1",
        extensionVersion: "0.3.11",
        configHash: "hash",
        startUrl: "https://example.com/exam",
        domain: "example.com",
        capabilities: ["screenshot.latest", "chat"]
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.ok(created.sessionId);
    assert.equal(created.displayId, "0001");
    assert.ok(created.extensionToken);
    assert.match(created.websocketUrl, /^ws:\/\//);

    const heartbeatResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/heartbeat`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.extensionToken}`
      },
      body: JSON.stringify({
        status: "active",
        currentUrl: "https://example.com/exam/page",
        chatOpen: false
      })
    });
    assert.equal(heartbeatResponse.status, 200);

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/aj4n0YAAAAASUVORK5CYII=", "base64");
    const form = new FormData();
    form.set("image", new Blob([png], { type: "image/png" }), "pixel.png");
    form.set("capturedAt", "2026-06-03T10:02:00.000Z");
    form.set("currentUrl", "https://example.com/exam/page");
    form.set("width", "1");
    form.set("height", "1");
    form.set("captureMethod", "tabs.captureVisibleTab");

    const screenshotResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/screenshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.extensionToken}` },
      body: form
    });
    assert.equal(screenshotResponse.status, 201);
    const screenshot = await screenshotResponse.json();
    assert.ok(screenshot.screenshotId);

    const sessionsResponse = await fetch(`${baseUrl}/v1/operator/sessions?status=active`);
    assert.equal(sessionsResponse.status, 200);
    const sessions = await sessionsResponse.json();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].displayId, "0001");
    assert.equal(sessions.sessions[0].domain, "example.com");
    assert.equal(sessions.sessions[0].assignedOperatorId, null);
    assert.ok(sessions.sessions[0].lastScreenshotUrl);

    const latestResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/screenshots/latest`);
    assert.equal(latestResponse.status, 200);
    assert.equal(latestResponse.headers.get("content-type"), "image/png");
    assert.equal(Buffer.byteLength(Buffer.from(await latestResponse.arrayBuffer())), png.length);

    const closeResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/close`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.extensionToken}`
      },
      body: JSON.stringify({ reason: "config_reset" })
    });
    assert.equal(closeResponse.status, 200);

    const defaultSessionsResponse = await fetch(`${baseUrl}/v1/operator/sessions`);
    assert.equal(defaultSessionsResponse.status, 200);
    const defaultSessions = await defaultSessionsResponse.json();
    assert.equal(defaultSessions.sessions.length, 0);
  } finally {
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("extension websocket accepts hello and forwards chat messages to operators", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seb-server-"));
  const service = createService({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    operatorApiToken: "operator-test-token",
    publicBaseUrl: ""
  });
  const baseUrl = await listen(service.server);
  const wsBaseUrl = baseUrl.replace(/^http:/, "ws:");
  const sockets = [];

  try {
    const createResponse = await fetch(`${baseUrl}/v1/extension/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: "install-2",
        domain: "example.org",
        capabilities: ["chat"]
      })
    });
    const created = await createResponse.json();

    const operatorSocket = new WebSocket(`${wsBaseUrl}/v1/operator/ws`);
    sockets.push(operatorSocket);
    const operatorHello = waitForJson(operatorSocket, (message) => message.type === "server.hello");
    await waitForOpen(operatorSocket);
    await operatorHello;

    const extensionSocket = new WebSocket(`${wsBaseUrl}/v1/extension/ws?sessionId=${created.sessionId}`);
    sockets.push(extensionSocket);
    await waitForOpen(extensionSocket);
    const extensionHello = waitForJson(extensionSocket, (message) => message.type === "server.hello");
    extensionSocket.send(JSON.stringify({
      type: "extension.hello",
      sessionId: created.sessionId,
      extensionToken: created.extensionToken,
      capabilities: ["chat"]
    }));

    const hello = await extensionHello;
    assert.equal(hello.sessionId, created.sessionId);

    const operatorMessage = waitForJson(extensionSocket, (message) => message.type === "operator.message");
    const operatorMessageResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "operator-client-message-1",
        text: "Здравствуйте.",
        operatorDisplayName: "Roman"
      })
    });
    assert.equal(operatorMessageResponse.status, 201);
    const operatorMessageCreated = await operatorMessageResponse.json();
    assert.equal(operatorMessageCreated.clientMessageId, "operator-client-message-1");
    assert.equal(operatorMessageCreated.operatorDisplayName, "Roman");
    const operatorMessagePayload = await operatorMessage;
    assert.equal(operatorMessagePayload.clientMessageId, "operator-client-message-1");
    assert.equal(operatorMessagePayload.operatorDisplayName, "Roman");
    assert.equal(operatorMessagePayload.text, "Здравствуйте.");
    assert.equal(Object.hasOwn(operatorMessagePayload, "openChat"), false);

    const unsupportedCommandResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "chat.open", payload: {} })
    });
    assert.equal(unsupportedCommandResponse.status, 400);

    extensionSocket.send(JSON.stringify({
      type: "chat.message",
      clientMessageId: "client-message-1",
      text: "Да, вижу.",
      createdAt: "2026-06-03T10:03:10.000Z"
    }));

    const forwarded = await waitForJson(operatorSocket, (message) => (
      message.type === "chat.message" && message.sessionId === created.sessionId
    ));
    assert.equal(forwarded.sender, "extension");
    assert.equal(forwarded.clientMessageId, "client-message-1");
    assert.equal(forwarded.text, "Да, вижу.");
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("extension sos signal highlights session and can be cleared by operator", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seb-server-"));
  const service = createService({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicBaseUrl: ""
  });
  const baseUrl = await listen(service.server);
  const wsBaseUrl = baseUrl.replace(/^http:/, "ws:");
  const sockets = [];

  try {
    const createResponse = await fetch(`${baseUrl}/v1/extension/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: "install-sos",
        domain: "exam.urfu.ru",
        currentUrl: "https://exam.urfu.ru/mod/quiz/attempt.php",
        capabilities: ["chat", "sos.hotkey"]
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    const operatorSocket = new WebSocket(`${wsBaseUrl}/v1/operator/ws`);
    sockets.push(operatorSocket);
    const operatorHello = waitForJson(operatorSocket, (message) => message.type === "server.hello");
    await waitForOpen(operatorSocket);
    await operatorHello;

    const sosEvent = waitForJson(operatorSocket, (message) => (
      message.type === "session.sos" && message.sessionId === created.sessionId
    ));
    const sosChat = waitForJson(operatorSocket, (message) => (
      message.type === "chat.message"
      && message.sessionId === created.sessionId
      && message.systemEvent === "sos.triggered"
    ));
    const sosResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/sos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.extensionToken}`
      },
      body: JSON.stringify({
        clientSignalId: "sos-client-1",
        sentAt: "2026-06-04T08:15:00.000Z",
        trigger: "hotkey",
        source: "extension",
        hotkey: {
          label: "Ctrl+Shift+4",
          code: "Digit4",
          ctrlKey: true,
          shiftKey: true
        },
        currentUrl: "https://exam.urfu.ru/mod/quiz/attempt.php?attempt=42",
        pageTitle: "Quiz attempt",
        displayId: created.displayId,
        extensionVersion: "0.4.0"
      })
    });
    assert.equal(sosResponse.status, 201);
    const sosCreated = await sosResponse.json();
    assert.ok(sosCreated.sosId);
    assert.equal(sosCreated.clientSignalId, "sos-client-1");
    assert.equal(sosCreated.active, true);

    const sosPayload = await sosEvent;
    assert.equal(sosPayload.sos.sosId, sosCreated.sosId);
    assert.equal(sosPayload.sos.active, true);
    assert.equal(sosPayload.sos.hotkey.label, "Ctrl+Shift+4");

    const sosMessage = await sosChat;
    assert.equal(sosMessage.sender, "system");
    assert.equal(sosMessage.text, "SOS signal was pressed");
    assert.equal(sosMessage.sosId, sosCreated.sosId);

    const sessionsResponse = await fetch(`${baseUrl}/v1/operator/sessions?status=active`);
    assert.equal(sessionsResponse.status, 200);
    const sessions = await sessionsResponse.json();
    assert.equal(sessions.sessions[0].sosActive, true);
    assert.equal(sessions.sessions[0].sos.sosId, sosCreated.sosId);

    const messagesResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/messages`);
    assert.equal(messagesResponse.status, 200);
    const messages = await messagesResponse.json();
    assert.equal(messages.messages[0].sender, "system");
    assert.equal(messages.messages[0].systemEvent, "sos.triggered");

    const clearEvent = waitForJson(operatorSocket, (message) => (
      message.type === "session.sos.cleared" && message.sessionId === created.sessionId
    ));
    const clearChat = waitForJson(operatorSocket, (message) => (
      message.type === "chat.message"
      && message.sessionId === created.sessionId
      && message.systemEvent === "sos.cleared"
    ));
    const clearResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/sos/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorDisplayName: "Roman" })
    });
    assert.equal(clearResponse.status, 200);
    const cleared = await clearResponse.json();
    assert.equal(cleared.session.sosActive, false);
    assert.equal(cleared.sos.active, false);
    assert.equal(cleared.sos.clearedByDisplayName, "Roman");

    const clearedPayload = await clearEvent;
    assert.equal(clearedPayload.sos.active, false);
    const clearMessage = await clearChat;
    assert.equal(clearMessage.sender, "system");
    assert.equal(clearMessage.text, "SOS signal was turned off");
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("extension release archive can be uploaded and downloaded", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seb-server-"));
  const service = createService({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    extensionReleaseUploadToken: "release-upload-token",
    publicBaseUrl: ""
  });
  const baseUrl = await listen(service.server);

  try {
    const emptyMetadataResponse = await fetch(`${baseUrl}/v1/extension-release/latest`);
    assert.equal(emptyMetadataResponse.status, 200);
    const emptyMetadata = await emptyMetadataResponse.json();
    assert.equal(emptyMetadata.release.available, false);

    const emptyDownloadResponse = await fetch(`${baseUrl}/downloads/extension/latest.zip`);
    assert.equal(emptyDownloadResponse.status, 404);

    const zip = Buffer.from([
      0x50, 0x4b, 0x03, 0x04,
      0x14, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ]);
    const unauthorizedForm = new FormData();
    unauthorizedForm.set("archive", new Blob([zip], { type: "application/zip" }), "seb-extension-v1.zip");
    const unauthorizedResponse = await fetch(`${baseUrl}/v1/releases/extension`, {
      method: "POST",
      body: unauthorizedForm
    });
    assert.equal(unauthorizedResponse.status, 401);

    const form = new FormData();
    form.set("archive", new Blob([zip], { type: "application/zip" }), "seb-extension-v1.zip");
    form.set("tagName", "v1.2.3");
    form.set("releaseName", "SEB Helper Pro v1.2.3");
    form.set("commitSha", "abc123");
    form.set("publishedAt", "2026-06-04T00:00:00.000Z");

    const uploadResponse = await fetch(`${baseUrl}/v1/releases/extension`, {
      method: "POST",
      headers: { Authorization: "Bearer release-upload-token" },
      body: form
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = await uploadResponse.json();
    assert.equal(uploaded.release.available, true);
    assert.equal(uploaded.release.tagName, "v1.2.3");
    assert.equal(uploaded.release.fileName, "seb-extension-v1.zip");
    assert.equal(uploaded.release.size, zip.length);
    assert.match(uploaded.release.sha256, /^[a-f0-9]{64}$/);
    assert.match(uploaded.release.downloadUrl, /\/downloads\/extension\/latest\.zip$/);

    const metadataResponse = await fetch(`${baseUrl}/v1/extension-release/latest`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.release.available, true);
    assert.equal(metadata.release.releaseName, "SEB Helper Pro v1.2.3");

    const downloadResponse = await fetch(`${baseUrl}/downloads/extension/latest.zip`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get("content-disposition") || "", /seb-extension-v1\.zip/);
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), zip);
  } finally {
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("moodle question snapshots and answers are forwarded over websockets", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seb-server-"));
  const service = createService({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicBaseUrl: ""
  });
  const baseUrl = await listen(service.server);
  const wsBaseUrl = baseUrl.replace(/^http:/, "ws:");
  const sockets = [];

  try {
    const createResponse = await fetch(`${baseUrl}/v1/extension/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: "install-moodle",
        domain: "exam2.urfu.ru",
        capabilities: ["moodle.question_snapshot"]
      })
    });
    const created = await createResponse.json();

    const operatorSocket = new WebSocket(`${wsBaseUrl}/v1/operator/ws`);
    sockets.push(operatorSocket);
    const operatorHello = waitForJson(operatorSocket, (message) => message.type === "server.hello");
    await waitForOpen(operatorSocket);
    await operatorHello;

    const extensionSocket = new WebSocket(`${wsBaseUrl}/v1/extension/ws?sessionId=${created.sessionId}`);
    sockets.push(extensionSocket);
    await waitForOpen(extensionSocket);
    const extensionHello = waitForJson(extensionSocket, (message) => message.type === "server.hello");
    extensionSocket.send(JSON.stringify({
      type: "extension.hello",
      sessionId: created.sessionId,
      extensionToken: created.extensionToken,
      capabilities: ["moodle.question_snapshot"]
    }));
    await extensionHello;

    const questionUpsert = waitForJson(operatorSocket, (message) => (
      message.type === "moodle.question.upsert" && message.sessionId === created.sessionId
    ));
    const questionResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/moodle/questions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.extensionToken}`
      },
      body: JSON.stringify({
        clientQuestionId: "attempt-786072-slot-6",
        pageUrl: "https://exam2.urfu.ru/mod/quiz/attempt.php?attempt=786072&cmid=645&page=5",
        baseUrl: "https://exam2.urfu.ru/mod/quiz/",
        attemptId: "786072",
        cmid: "645",
        slot: "6",
        questionNumber: "6",
        questionType: "match",
        questionFingerprint: "q910995:6",
        html: "<div id=\"question-910995-6\" class=\"que match\"><select name=\"q910995:6_sub0\"><option value=\"1\">A</option></select></div>",
        controls: [{
          name: "q910995:6_sub0",
          id: "q910995:6_sub0",
          type: "select",
          options: [{ value: "1", label: "A" }]
        }],
        moodle: {
          version: "2023100902",
          theme: "classic"
        }
      })
    });
    assert.equal(questionResponse.status, 201);
    const questionCreated = await questionResponse.json();
    assert.ok(questionCreated.questionId);

    const upsert = await questionUpsert;
    assert.equal(upsert.question.questionType, "match");
    assert.equal(upsert.question.controls[0].name, "q910995:6_sub0");

    const listResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/moodle/questions`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.questions.length, 1);
    assert.equal(list.questions[0].clientQuestionId, "attempt-786072-slot-6");

    const extensionAnswer = waitForJson(extensionSocket, (message) => message.type === "moodle.answer");
    const answerResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/moodle/questions/${questionCreated.questionId}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [{
          name: "q910995:6_sub0",
          id: "q910995:6_sub0",
          type: "select",
          value: "1"
        }, {
          name: "q910995:6_p1",
          id: "drop-1",
          selector: "#drop-1",
          type: "dragdrop",
          value: "2",
          text: "Address"
        }],
        operatorDisplayName: "Roman"
      })
    });
    assert.equal(answerResponse.status, 201);
    const answerCreated = await answerResponse.json();
    assert.equal(answerCreated.deliveryStatus, "delivered");
    assert.equal(answerCreated.hotkey.label, "Ctrl+Shift+2");

    const answer = await extensionAnswer;
    assert.equal(answer.questionId, questionCreated.questionId);
    assert.equal(answer.hotkey.code, "Digit2");
    assert.equal(answer.fields[0].value, "1");
    assert.equal(answer.fields[1].type, "dragdrop");
    assert.equal(answer.fields[1].text, "Address");

    const resultMessage = waitForJson(operatorSocket, (message) => (
      message.type === "moodle.answer.result" && message.answerId === answer.answerId
    ));
    extensionSocket.send(JSON.stringify({
      type: "moodle.answer.result",
      questionId: answer.questionId,
      answerId: answer.answerId,
      status: "ok",
      payload: { appliedFieldCount: 1 }
    }));

    const result = await resultMessage;
    assert.equal(result.status, "ok");
    assert.equal(result.payload.appliedFieldCount, 1);

    const secondQuestionUpsert = waitForJson(operatorSocket, (message) => (
      message.type === "moodle.question.upsert"
      && message.sessionId === created.sessionId
      && message.question.clientQuestionId === "attempt-786072-slot-7"
    ));
    const secondQuestionResponse = await fetch(`${baseUrl}/v1/extension/sessions/${created.sessionId}/moodle/questions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.extensionToken}`
      },
      body: JSON.stringify({
        clientQuestionId: "attempt-786072-slot-7",
        pageUrl: "https://exam2.urfu.ru/mod/quiz/attempt.php?attempt=786072&cmid=645&page=6",
        baseUrl: "https://exam2.urfu.ru/mod/quiz/",
        attemptId: "786072",
        cmid: "645",
        slot: "7",
        questionNumber: "7",
        questionType: "multichoice",
        questionFingerprint: "q910995:7",
        html: "<div id=\"question-910995-7\" class=\"que multichoice\"><input name=\"q910995:7_answer\" type=\"radio\" value=\"1\"></div>",
        controls: [{
          name: "q910995:7_answer",
          id: "q910995:7_answer",
          type: "radio",
          value: "1"
        }]
      })
    });
    assert.equal(secondQuestionResponse.status, 201);
    const secondQuestionCreated = await secondQuestionResponse.json();
    await secondQuestionUpsert;

    const currentListResponse = await fetch(`${baseUrl}/v1/operator/sessions/${created.sessionId}/moodle/questions`);
    assert.equal(currentListResponse.status, 200);
    const currentList = await currentListResponse.json();
    assert.equal(currentList.questions.length, 1);
    assert.equal(currentList.questions[0].questionId, secondQuestionCreated.questionId);
    assert.equal(currentList.questions[0].clientQuestionId, "attempt-786072-slot-7");
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

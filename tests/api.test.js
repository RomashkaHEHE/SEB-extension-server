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
    assert.equal(forwarded.text, "Да, вижу.");
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await close(service.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

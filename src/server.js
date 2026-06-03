require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const DEFAULT_SCREENSHOT_INTERVAL_SECONDS = 120;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
const STALE_AFTER_MS = 90 * 1000;
const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const WS_OPEN = 1;
const QUESTION_HTML_MAX_CHARS = 900_000;
const QUESTION_TEXT_MAX_CHARS = 20_000;
const DEFAULT_EXTENSION_RELEASE_MAX_BYTES = 80 * 1024 * 1024;
const MOODLE_HOTKEY = {
  label: "Ctrl+Shift+2",
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  key: "2",
  code: "Digit2"
};
const SUPPORTED_COMMANDS = new Set([
  "screenshot.capture_now"
]);

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function writeJsonFile(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function writeBufferFileAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, value);
  fs.renameSync(tmpPath, filePath);
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function getBearerToken(rawHeader) {
  if (!rawHeader || typeof rawHeader !== "string") {
    return "";
  }
  const [type, token] = rawHeader.split(/\s+/, 2);
  return type && type.toLowerCase() === "bearer" ? token || "" : "";
}

function safeEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function jsonError(res, statusCode, code, message) {
  return res.status(statusCode).json({ error: { code, message } });
}

function sanitizeFileExtension(mimetype) {
  if (mimetype === "image/png") {
    return "png";
  }
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
    return "jpg";
  }
  return "";
}

function isZipArchive(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b;
}

function sanitizeDownloadFileName(value, fallback = "seb-extension.zip") {
  const raw = path.basename(String(value || fallback)).trim();
  const cleaned = raw
    .replace(/[^\w.()+ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 140);
  return cleaned.toLowerCase().endsWith(".zip") ? cleaned : `${cleaned || "seb-extension"}.zip`;
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDisplayId(value) {
  return String(value).padStart(4, "0");
}

function parseDisplayId(value) {
  const match = String(value || "").match(/^#?(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeDisplayName(value) {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return normalized.slice(0, 80);
}

function normalizeString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeLooseString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeControl(control) {
  const source = normalizePlainObject(control);
  const options = Array.isArray(source.options) ? source.options.slice(0, 200).map((option) => {
    const optionSource = normalizePlainObject(option);
    return {
      value: normalizeLooseString(optionSource.value, 500),
      label: normalizeString(optionSource.label, 1000),
      html: normalizeLooseString(optionSource.html, 10_000),
      selected: Boolean(optionSource.selected),
      checked: Boolean(optionSource.checked),
      disabled: Boolean(optionSource.disabled)
    };
  }) : [];

  return {
    controlId: normalizeString(source.controlId || source.id || source.name, 160),
    name: normalizeString(source.name, 300),
    id: normalizeString(source.id, 300),
    selector: normalizeString(source.selector, 1000),
    type: normalizeString(source.type || source.tagName || source.kind, 80).toLowerCase(),
    label: normalizeString(source.label, 2000),
    labelHtml: normalizeLooseString(source.labelHtml, 20_000),
    value: normalizeLooseString(source.value, 10_000),
    checked: Boolean(source.checked),
    multiple: Boolean(source.multiple),
    disabled: Boolean(source.disabled),
    required: Boolean(source.required),
    options
  };
}

function normalizeAnswerField(field) {
  const source = normalizePlainObject(field);
  return {
    controlId: normalizeString(source.controlId || source.id || source.name, 160),
    name: normalizeString(source.name, 300),
    id: normalizeString(source.id, 300),
    selector: normalizeString(source.selector, 1000),
    type: normalizeString(source.type || source.kind, 80).toLowerCase(),
    value: normalizeLooseString(source.value, 20_000),
    values: Array.isArray(source.values) ? source.values.slice(0, 100).map((value) => normalizeLooseString(value, 2000)) : [],
    text: normalizeString(source.text, 2000),
    checked: typeof source.checked === "boolean" ? source.checked : null
  };
}

function normalizeHotkey(value) {
  const source = normalizePlainObject(value);
  return {
    label: normalizeString(source.label, 80),
    code: normalizeString(source.code, 80),
    key: normalizeString(source.key, 40),
    ctrlKey: Boolean(source.ctrlKey),
    shiftKey: Boolean(source.shiftKey),
    altKey: Boolean(source.altKey),
    metaKey: Boolean(source.metaKey)
  };
}

function createState(dataDir) {
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, "screenshots"));

  const statePath = path.join(dataDir, "remote-sessions.json");
  const state = readJsonFile(statePath, {
    sessions: {},
    messages: {},
    moodleQuestions: {},
    auditLog: []
  });

  state.sessions ||= {};
  state.messages ||= {};
  state.moodleQuestions ||= {};
  state.auditLog ||= [];
  state.nextDisplayNumber = parsePositiveInt(state.nextDisplayNumber, 1);

  let changed = false;
  let nextDisplayNumber = state.nextDisplayNumber;
  let maxDisplayNumber = 0;
  const sessionsByStart = Object.values(state.sessions)
    .sort((left, right) => Date.parse(left.startedAt || 0) - Date.parse(right.startedAt || 0));

  for (const session of sessionsByStart) {
    const existingNumber = parseDisplayId(session.displayId);
    if (existingNumber) {
      maxDisplayNumber = Math.max(maxDisplayNumber, existingNumber);
      continue;
    }
    session.displayId = formatDisplayId(nextDisplayNumber);
    maxDisplayNumber = Math.max(maxDisplayNumber, nextDisplayNumber);
    nextDisplayNumber += 1;
    changed = true;
  }

  const normalizedNextDisplayNumber = Math.max(nextDisplayNumber, maxDisplayNumber + 1);
  if (state.nextDisplayNumber !== normalizedNextDisplayNumber) {
    state.nextDisplayNumber = normalizedNextDisplayNumber;
    changed = true;
  }

  function save() {
    writeJsonFile(statePath, state);
  }

  if (changed) {
    save();
  }

  return { state, save, screenshotsDir: path.join(dataDir, "screenshots") };
}

function createService(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const config = {
    host: options.host || process.env.HOST || "0.0.0.0",
    port: parsePositiveInt(options.port || process.env.PORT, 3000),
    publicBaseUrl: options.publicBaseUrl || process.env.PUBLIC_BASE_URL || "",
    corsOrigin: options.corsOrigin ?? process.env.CORS_ORIGIN ?? "",
    dataDir,
    screenshotMaxBytes: parsePositiveInt(
      options.screenshotMaxBytes || process.env.SCREENSHOT_MAX_BYTES,
      8 * 1024 * 1024
    ),
    extensionReleaseUploadToken: options.extensionReleaseUploadToken || process.env.EXTENSION_RELEASE_UPLOAD_TOKEN || "",
    extensionReleaseDir: path.resolve(
      options.extensionReleaseDir || process.env.EXTENSION_RELEASE_DIR || path.join(dataDir, "extension-release")
    ),
    extensionReleaseMaxBytes: parsePositiveInt(
      options.extensionReleaseMaxBytes || process.env.EXTENSION_RELEASE_MAX_BYTES,
      DEFAULT_EXTENSION_RELEASE_MAX_BYTES
    )
  };

  const { state, save, screenshotsDir } = createState(config.dataDir);
  ensureDir(config.extensionReleaseDir);
  const app = express();
  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });
  const extensionSockets = new Map();
  const operatorSockets = new Set();

  app.set("trust proxy", true);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameSrc: ["'self'", "data:", "blob:"],
        imgSrc: ["'self'", "https:", "data:", "blob:"],
        mediaSrc: ["'self'", "https:", "data:", "blob:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  }));
  app.use(cors({
    origin: config.corsOrigin ? config.corsOrigin.split(",").map((origin) => origin.trim()) : true,
    credentials: true
  }));
  app.use(express.json({ limit: "5mb" }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(express.static(path.join(__dirname, "..", "public")));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.screenshotMaxBytes },
    fileFilter: (_req, file, callback) => {
      const ext = sanitizeFileExtension(file.mimetype);
      callback(ext ? null : new Error("unsupported_image_type"), Boolean(ext));
    }
  });
  const extensionReleaseUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.extensionReleaseMaxBytes },
    fileFilter: (_req, file, callback) => {
      const fileName = String(file.originalname || "").toLowerCase();
      callback(fileName.endsWith(".zip") ? null : new Error("unsupported_release_type"), fileName.endsWith(".zip"));
    }
  }).single("archive");

  const extensionReleaseArchivePath = path.join(config.extensionReleaseDir, "latest.zip");
  const extensionReleaseMetadataPath = path.join(config.extensionReleaseDir, "latest.json");

  function getBaseUrl(req) {
    if (config.publicBaseUrl) {
      return config.publicBaseUrl.replace(/\/+$/, "");
    }
    const forwardedProtocol = req.get("x-forwarded-proto");
    const protocol = forwardedProtocol ? forwardedProtocol.split(",")[0].trim() : req.protocol;
    return `${protocol}://${req.get("host")}`;
  }

  function getExtensionReleaseDownloadUrl(req) {
    return `${getBaseUrl(req)}/downloads/extension/latest.zip`;
  }

  function readExtensionReleaseMetadata() {
    return readJsonFile(extensionReleaseMetadataPath, null);
  }

  function serializeExtensionRelease(req) {
    const metadata = readExtensionReleaseMetadata();
    const available = Boolean(metadata && fs.existsSync(extensionReleaseArchivePath));
    return {
      available,
      downloadUrl: available ? getExtensionReleaseDownloadUrl(req) : null,
      fileName: available ? metadata.fileName || "seb-extension.zip" : "",
      originalName: available ? metadata.originalName || "" : "",
      tagName: available ? metadata.tagName || "" : "",
      version: available ? metadata.version || "" : "",
      releaseName: available ? metadata.releaseName || "" : "",
      commitSha: available ? metadata.commitSha || "" : "",
      size: available ? metadata.size || 0 : 0,
      sha256: available ? metadata.sha256 || "" : "",
      publishedAt: available ? metadata.publishedAt || null : null,
      uploadedAt: available ? metadata.uploadedAt || null : null
    };
  }

  function requireExtensionReleaseUpload(req, res, next) {
    if (!config.extensionReleaseUploadToken) {
      return jsonError(res, 503, "release_upload_not_configured", "Extension release upload token is not configured");
    }
    const token = getBearerToken(req.get("authorization"));
    if (!safeEqual(config.extensionReleaseUploadToken, token)) {
      return jsonError(res, 401, "invalid_token", "Release upload token is invalid");
    }
    return next();
  }

  function getWebSocketUrl(req, kind) {
    const baseUrl = getBaseUrl(req);
    const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${wsBase}/v1/${kind}/ws`;
  }

  function deriveSessionStatus(session, at = Date.now()) {
    if (!session || session.status === "closed") {
      return "closed";
    }
    const lastSeenTime = Date.parse(session.lastSeenAt || session.startedAt || 0);
    if (!Number.isFinite(lastSeenTime)) {
      return "offline";
    }
    const age = at - lastSeenTime;
    if (age > OFFLINE_AFTER_MS) {
      return "offline";
    }
    if (age > STALE_AFTER_MS) {
      return "stale";
    }
    return "active";
  }

  function getScreenshotUrl(req, sessionId) {
    return `${getBaseUrl(req)}/v1/operator/sessions/${sessionId}/screenshots/latest`;
  }

  function allocateDisplayId() {
    const value = parsePositiveInt(state.nextDisplayNumber, 1);
    state.nextDisplayNumber = value + 1;
    return formatDisplayId(value);
  }

  function getSessionQuestions(sessionId) {
    state.moodleQuestions[sessionId] ||= [];
    return state.moodleQuestions[sessionId];
  }

  function getQuestion(sessionId, questionId) {
    return getSessionQuestions(sessionId).find((question) => question.questionId === questionId) || null;
  }

  function getLatestQuestion(sessionId) {
    const questions = getSessionQuestions(sessionId);
    return questions
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt || right.receivedAt || 0) - Date.parse(left.updatedAt || left.receivedAt || 0))[0] || null;
  }

  function getCurrentQuestions(sessionId, status = "") {
    const latestQuestion = getLatestQuestion(sessionId);
    if (!latestQuestion || (status && latestQuestion.status !== status)) {
      return [];
    }
    return [latestQuestion];
  }

  function serializeMoodleQuestion(question) {
    return {
      questionId: question.questionId,
      clientQuestionId: question.clientQuestionId || "",
      sessionId: question.sessionId,
      status: question.status || "open",
      pageUrl: question.pageUrl || "",
      baseUrl: question.baseUrl || "",
      attemptId: question.attemptId || "",
      cmid: question.cmid || "",
      slot: question.slot || "",
      questionNumber: question.questionNumber || "",
      questionType: question.questionType || "",
      questionState: question.questionState || "",
      questionFingerprint: question.questionFingerprint || "",
      title: question.title || "",
      text: question.text || "",
      html: question.html || "",
      controls: Array.isArray(question.controls) ? question.controls : [],
      moodle: question.moodle || {},
      receivedAt: question.receivedAt,
      updatedAt: question.updatedAt,
      latestAnswer: question.latestAnswer || null
    };
  }

  function serializeMoodleAnswer(answer) {
    return {
      answerId: answer.answerId,
      questionId: answer.questionId,
      clientQuestionId: answer.clientQuestionId || "",
      questionFingerprint: answer.questionFingerprint || "",
      applyMode: answer.applyMode || "on_hotkey",
      hotkey: MOODLE_HOTKEY,
      fields: Array.isArray(answer.fields) ? answer.fields : [],
      submit: Boolean(answer.submit),
      operatorDisplayName: answer.operatorDisplayName || "",
      createdAt: answer.createdAt
    };
  }

  function isSosActive(session) {
    return Boolean(session?.activeSos && !session.activeSos.clearedAt);
  }

  function serializeSos(sos) {
    if (!sos) {
      return null;
    }
    return {
      sosId: sos.sosId || "",
      clientSignalId: sos.clientSignalId || "",
      active: !sos.clearedAt,
      sentAt: sos.sentAt || null,
      receivedAt: sos.receivedAt || null,
      clearedAt: sos.clearedAt || null,
      trigger: sos.trigger || "",
      source: sos.source || "",
      currentUrl: sos.currentUrl || "",
      pageTitle: sos.pageTitle || "",
      displayId: sos.displayId || "",
      extensionVersion: sos.extensionVersion || "",
      hotkey: sos.hotkey || null,
      clearedByDisplayName: sos.clearedByDisplayName || ""
    };
  }

  function serializeSession(session, req = null) {
    const sessionId = session.sessionId;
    const latestQuestion = getLatestQuestion(sessionId);
    return {
      sessionId,
      displayId: session.displayId || "",
      status: deriveSessionStatus(session),
      domain: session.domain || "",
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      lastScreenshotAt: session.lastScreenshotAt || null,
      lastScreenshotUrl: session.lastScreenshot ? (
        req ? getScreenshotUrl(req, sessionId) : `/v1/operator/sessions/${sessionId}/screenshots/latest`
      ) : null,
      currentUrl: session.currentUrl || session.startUrl || "",
      capabilities: asArray(session.capabilities),
      assignedOperatorId: null,
      extensionVersion: session.extensionVersion || "",
      installId: session.installId || "",
      userLabel: session.userLabel || "",
      chatOpen: Boolean(session.chatOpen),
      sosActive: isSosActive(session),
      sos: serializeSos(session.activeSos),
      moodleQuestionCount: latestQuestion ? 1 : 0,
      latestMoodleQuestionAt: latestQuestion?.updatedAt || latestQuestion?.receivedAt || null,
      extensionSocketConnected: extensionSockets.has(sessionId)
    };
  }

  function sendJson(socket, payload) {
    if (socket.readyState === WS_OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function broadcastOperators(payload) {
    for (const socket of operatorSockets) {
      sendJson(socket, payload);
    }
  }

  function broadcastSessionUpsert(session, req = null) {
    broadcastOperators({
      type: "session.upsert",
      session: serializeSession(session, req)
    });
  }

  function audit(action, sessionId, operatorId, details = {}) {
    state.auditLog.push({
      auditId: createId(),
      action,
      sessionId,
      operatorId: operatorId || null,
      details,
      createdAt: nowIso()
    });
    if (state.auditLog.length > 1000) {
      state.auditLog.splice(0, state.auditLog.length - 1000);
    }
  }

  function getSession(sessionId) {
    return state.sessions[sessionId] || null;
  }

  function appendSystemMessage(session, systemEvent, text, extra = {}) {
    const message = {
      messageId: createId(),
      clientMessageId: extra.clientMessageId || "",
      sessionId: session.sessionId,
      sender: "system",
      systemEvent,
      text,
      createdAt: extra.createdAt || nowIso(),
      sosId: extra.sosId || "",
      trigger: extra.trigger || "",
      source: extra.source || "",
      currentUrl: extra.currentUrl || ""
    };
    state.messages[session.sessionId] ||= [];
    state.messages[session.sessionId].push(message);
    return message;
  }

  function broadcastChatMessage(message) {
    broadcastOperators({
      type: "chat.message",
      sessionId: message.sessionId,
      messageId: message.messageId,
      clientMessageId: message.clientMessageId || "",
      sender: message.sender,
      systemEvent: message.systemEvent || "",
      operatorDisplayName: message.operatorDisplayName || "",
      text: message.text,
      createdAt: message.createdAt,
      sosId: message.sosId || "",
      trigger: message.trigger || "",
      source: message.source || "",
      currentUrl: message.currentUrl || "",
      deliveryStatus: message.deliveryStatus || ""
    });
  }

  function requireExtensionSession(req, res, next) {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    if (session.status === "closed") {
      return jsonError(res, 409, "session_closed", "Session is already closed");
    }
    const token = getBearerToken(req.get("authorization"));
    if (!safeEqual(session.extensionToken, token)) {
      return jsonError(res, 401, "invalid_token", "Extension token is invalid");
    }
    req.remoteSession = session;
    return next();
  }

  function requireOperator(req, res, next) {
    void req;
    void res;
    return next();
  }

  function sendQueuedOperatorMessages(session) {
    const socket = extensionSockets.get(session.sessionId);
    if (!socket || socket.readyState !== WS_OPEN) {
      return;
    }
    const messages = state.messages[session.sessionId] || [];
    let delivered = false;
    for (const message of messages) {
      if (message.sender === "operator" && message.deliveryStatus !== "delivered") {
        sendJson(socket, {
          type: "operator.message",
          messageId: message.messageId,
          clientMessageId: message.clientMessageId,
          operatorId: message.operatorId,
          operatorDisplayName: message.operatorDisplayName || "",
          text: message.text,
          createdAt: message.createdAt
        });
        message.deliveryStatus = "delivered";
        delivered = true;
      }
    }
    if (delivered) {
      save();
    }
  }

  function sendQueuedMoodleAnswers(session) {
    const socket = extensionSockets.get(session.sessionId);
    if (!socket || socket.readyState !== WS_OPEN) {
      return;
    }

    let delivered = false;
    for (const question of getSessionQuestions(session.sessionId)) {
      for (const answer of question.answers || []) {
        if (answer.status === "ok" || answer.status === "error") {
          continue;
        }
        sendJson(socket, {
          type: "moodle.answer",
          ...serializeMoodleAnswer(answer)
        });
        if (answer.deliveryStatus === "delivered") {
          answer.redeliveredAt = nowIso();
        }
        answer.deliveryStatus = "delivered";
        answer.deliveredAt ||= nowIso();
        question.latestAnswer = {
          answerId: answer.answerId,
          deliveryStatus: answer.deliveryStatus,
          status: answer.status,
          createdAt: answer.createdAt,
          deliveredAt: answer.deliveredAt,
          redeliveredAt: answer.redeliveredAt || null
        };
        delivered = true;
      }
    }

    if (delivered) {
      save();
    }
  }

  function attachExtensionSocket(socket, session, capabilities = []) {
    const previousSocket = extensionSockets.get(session.sessionId);
    if (previousSocket && previousSocket !== socket && previousSocket.readyState === WS_OPEN) {
      previousSocket.close(1000, "Replaced by a newer extension socket");
    }

    socket.remoteSessionId = session.sessionId;
    extensionSockets.set(session.sessionId, socket);
    session.capabilities = capabilities.length ? capabilities : asArray(session.capabilities);
    session.lastSeenAt = nowIso();
    session.status = "active";
    session.extensionSocketConnectedAt = nowIso();
    save();

    sendJson(socket, {
      type: "server.hello",
      sessionId: session.sessionId,
      serverTime: nowIso()
    });
    sendQueuedOperatorMessages(session);
    sendQueuedMoodleAnswers(session);
    broadcastSessionUpsert(session);
  }

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", serverTime: nowIso() });
  });

  app.get("/v1/health", (_req, res) => {
    res.json({ status: "ok", serverTime: nowIso() });
  });

  app.get(["/interface", "/interface/"], (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "interface.html"));
  });

  app.get("/v1/extension-release/latest", (req, res) => {
    res.json({ release: serializeExtensionRelease(req) });
  });

  app.get("/downloads/extension/latest.zip", (req, res) => {
    const release = serializeExtensionRelease(req);
    if (!release.available) {
      return jsonError(res, 404, "extension_release_not_found", "Extension release archive was not uploaded yet");
    }
    res.setHeader("Cache-Control", "no-store");
    return res.download(extensionReleaseArchivePath, release.fileName || "seb-extension.zip");
  });

  app.post("/v1/releases/extension", requireExtensionReleaseUpload, (req, res, next) => {
    extensionReleaseUpload(req, res, (error) => {
      if (error) {
        return next(error);
      }
      if (!req.file) {
        return jsonError(res, 400, "release_archive_required", "Multipart field archive with a .zip file is required");
      }
      if (!isZipArchive(req.file.buffer)) {
        return jsonError(res, 415, "unsupported_release_type", "Only ZIP archives are supported");
      }

      const tagName = normalizeString(req.body?.tagName || req.body?.tag || "", 160);
      const version = normalizeString(req.body?.version || tagName.replace(/^v/i, ""), 160);
      const fileName = sanitizeDownloadFileName(
        req.body?.fileName || req.file.originalname || (tagName ? `seb-extension-${tagName}.zip` : "seb-extension.zip")
      );
      const metadata = {
        fileName,
        originalName: sanitizeDownloadFileName(req.file.originalname || fileName),
        tagName,
        version,
        releaseName: normalizeString(req.body?.releaseName || req.body?.name || "", 300),
        commitSha: normalizeString(req.body?.commitSha || req.body?.sha || "", 80),
        size: req.file.size,
        sha256: crypto.createHash("sha256").update(req.file.buffer).digest("hex"),
        publishedAt: normalizeString(req.body?.publishedAt, 80) || null,
        uploadedAt: nowIso()
      };

      writeBufferFileAtomic(extensionReleaseArchivePath, req.file.buffer);
      writeJsonFile(extensionReleaseMetadataPath, metadata);

      return res.status(201).json({
        release: serializeExtensionRelease(req)
      });
    });
  });

  app.post("/v1/extension/sessions", (req, res) => {
    const sessionId = createId();
    const createdAt = nowIso();
    const body = req.body || {};
    const session = {
      sessionId,
      displayId: allocateDisplayId(),
      extensionToken: createToken(),
      installId: typeof body.installId === "string" ? body.installId : "",
      extensionVersion: typeof body.extensionVersion === "string" ? body.extensionVersion : "",
      configHash: typeof body.configHash === "string" ? body.configHash : "",
      startUrl: typeof body.startUrl === "string" ? body.startUrl : "",
      currentUrl: typeof body.startUrl === "string" ? body.startUrl : "",
      domain: typeof body.domain === "string" ? body.domain : "",
      capabilities: asArray(body.capabilities),
      userLabel: typeof body.userLabel === "string" ? body.userLabel : "",
      status: "active",
      startedAt: createdAt,
      lastSeenAt: createdAt,
      lastScreenshotAt: null,
      lastScreenshot: null,
      chatOpen: false,
      commands: []
    };

    state.sessions[sessionId] = session;
    state.messages[sessionId] = [];
    save();
    broadcastSessionUpsert(session, req);

    res.status(201).json({
      sessionId,
      displayId: session.displayId,
      extensionToken: session.extensionToken,
      websocketUrl: getWebSocketUrl(req, "extension"),
      screenshotIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
      heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      serverTime: nowIso()
    });
  });

  app.patch("/v1/extension/sessions/:sessionId/heartbeat", requireExtensionSession, (req, res) => {
    const session = req.remoteSession;
    const body = req.body || {};
    session.status = "active";
    session.lastSeenAt = nowIso();
    if (typeof body.currentUrl === "string") {
      session.currentUrl = body.currentUrl;
    }
    if (typeof body.chatOpen === "boolean") {
      session.chatOpen = body.chatOpen;
    }
    if (typeof body.lastScreenshotAt === "string") {
      session.lastScreenshotAt = body.lastScreenshotAt;
    }
    save();
    broadcastSessionUpsert(session, req);
    res.json({ status: "ok", serverTime: nowIso() });
  });

  app.post("/v1/extension/sessions/:sessionId/screenshots", requireExtensionSession, upload.single("image"), (req, res) => {
    const session = req.remoteSession;
    if (!req.file) {
      return jsonError(res, 400, "screenshot_not_found", "Field image is required");
    }

    const ext = sanitizeFileExtension(req.file.mimetype);
    if (!ext) {
      return jsonError(res, 415, "unsupported_image_type", "Only JPEG and PNG screenshots are supported");
    }

    const screenshotId = createId();
    const fileName = `${session.sessionId}-${screenshotId}.${ext}`;
    const filePath = path.join(screenshotsDir, fileName);
    fs.writeFileSync(filePath, req.file.buffer);

    if (session.lastScreenshot?.fileName && session.lastScreenshot.fileName !== fileName) {
      const previousPath = path.join(screenshotsDir, session.lastScreenshot.fileName);
      fs.rmSync(previousPath, { force: true });
    }

    const capturedAt = typeof req.body.capturedAt === "string" ? req.body.capturedAt : nowIso();
    session.lastScreenshotAt = capturedAt;
    session.lastScreenshot = {
      screenshotId,
      fileName,
      contentType: req.file.mimetype,
      capturedAt,
      currentUrl: typeof req.body.currentUrl === "string" ? req.body.currentUrl : session.currentUrl || "",
      width: Number.parseInt(req.body.width, 10) || null,
      height: Number.parseInt(req.body.height, 10) || null,
      captureMethod: typeof req.body.captureMethod === "string" ? req.body.captureMethod : "",
      receivedAt: nowIso()
    };
    if (session.lastScreenshot.currentUrl) {
      session.currentUrl = session.lastScreenshot.currentUrl;
    }
    save();

    broadcastSessionUpsert(session, req);
    broadcastOperators({
      type: "session.screenshot_updated",
      sessionId: session.sessionId,
      screenshotId,
      capturedAt,
      url: getScreenshotUrl(req, session.sessionId)
    });

    return res.status(201).json({
      screenshotId,
      receivedAt: session.lastScreenshot.receivedAt
    });
  });

  app.post("/v1/extension/sessions/:sessionId/moodle/questions", requireExtensionSession, (req, res) => {
    const session = req.remoteSession;
    const body = req.body || {};
    const html = normalizeLooseString(body.html, QUESTION_HTML_MAX_CHARS);
    const text = normalizeString(body.text, QUESTION_TEXT_MAX_CHARS);
    const controls = Array.isArray(body.controls) ? body.controls.slice(0, 400).map(normalizeControl) : [];

    if (!html && !text && !controls.length) {
      return jsonError(res, 400, "invalid_moodle_question", "Question html, text, or controls are required");
    }

    const questions = getSessionQuestions(session.sessionId);
    const clientQuestionId = normalizeString(body.clientQuestionId, 160);
    const existing = clientQuestionId
      ? questions.find((question) => question.clientQuestionId === clientQuestionId)
      : null;
    const receivedAt = nowIso();
    const question = existing || {
      questionId: createId(),
      clientQuestionId,
      sessionId: session.sessionId,
      receivedAt,
      answers: []
    };

    question.status = normalizeString(body.status, 40) || "open";
    question.pageUrl = normalizeString(body.pageUrl, 2000);
    question.baseUrl = normalizeString(body.baseUrl, 2000);
    question.attemptId = normalizeString(body.attemptId, 120);
    question.cmid = normalizeString(body.cmid, 120);
    question.slot = normalizeString(body.slot, 120);
    question.questionNumber = normalizeString(body.questionNumber, 120);
    question.questionType = normalizeString(body.questionType, 120);
    question.questionState = normalizeString(body.questionState, 120);
    question.questionFingerprint = normalizeString(body.questionFingerprint, 300);
    question.title = normalizeString(body.title, 1000);
    question.text = text;
    question.html = html;
    question.controls = controls;
    question.moodle = normalizePlainObject(body.moodle);
    question.updatedAt = receivedAt;

    questions.splice(0, questions.length, question);
    if (question.pageUrl) {
      session.currentUrl = question.pageUrl;
    }
    session.lastSeenAt = receivedAt;
    save();

    const serializedQuestion = serializeMoodleQuestion(question);
    broadcastOperators({
      type: "moodle.question.upsert",
      sessionId: session.sessionId,
      question: serializedQuestion
    });
    broadcastSessionUpsert(session, req);

    return res.status(existing ? 200 : 201).json({
      questionId: question.questionId,
      clientQuestionId: question.clientQuestionId,
      receivedAt: question.receivedAt,
      updatedAt: question.updatedAt
    });
  });

  app.post("/v1/extension/sessions/:sessionId/sos", requireExtensionSession, (req, res) => {
    const session = req.remoteSession;
    const body = req.body || {};
    const receivedAt = nowIso();
    const sentAt = normalizeString(body.sentAt, 80) || receivedAt;
    const currentUrl = normalizeString(body.currentUrl, 2000);
    const sos = {
      sosId: createId(),
      clientSignalId: normalizeString(body.clientSignalId, 160),
      sentAt,
      receivedAt,
      trigger: normalizeString(body.trigger, 80) || "hotkey",
      source: normalizeString(body.source, 80) || "extension",
      hotkey: normalizeHotkey(body.hotkey),
      currentUrl,
      pageTitle: normalizeString(body.pageTitle, 1000),
      displayId: normalizeString(body.displayId, 80),
      extensionVersion: normalizeString(body.extensionVersion, 80)
    };

    session.activeSos = sos;
    session.lastSosAt = sentAt;
    session.lastSeenAt = receivedAt;
    if (currentUrl) {
      session.currentUrl = currentUrl;
    }

    const chatMessage = appendSystemMessage(
      session,
      "sos.triggered",
      "SOS signal was pressed",
      {
        clientMessageId: sos.clientSignalId ? `sos:${sos.clientSignalId}` : "",
        createdAt: receivedAt,
        sosId: sos.sosId,
        trigger: sos.trigger,
        source: sos.source,
        currentUrl: sos.currentUrl
      }
    );
    audit("sos.triggered", session.sessionId, "extension", {
      sosId: sos.sosId,
      clientSignalId: sos.clientSignalId,
      trigger: sos.trigger,
      source: sos.source
    });
    save();

    broadcastSessionUpsert(session, req);
    broadcastOperators({
      type: "session.sos",
      sessionId: session.sessionId,
      sos: serializeSos(sos)
    });
    broadcastChatMessage(chatMessage);

    return res.status(201).json({
      sosId: sos.sosId,
      clientSignalId: sos.clientSignalId,
      active: true,
      receivedAt
    });
  });

  app.patch("/v1/extension/sessions/:sessionId/close", requireExtensionSession, (req, res) => {
    const session = req.remoteSession;
    const closedAt = nowIso();
    session.status = "closed";
    session.closedAt = closedAt;
    session.closeReason = typeof req.body?.reason === "string" ? req.body.reason : "unknown";
    save();

    const socket = extensionSockets.get(session.sessionId);
    if (socket && socket.readyState === WS_OPEN) {
      socket.close(1000, "Session closed");
    }
    extensionSockets.delete(session.sessionId);
    broadcastSessionUpsert(session, req);

    res.json({ status: "closed", closedAt });
  });

  app.get("/v1/operator/sessions", requireOperator, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "active";
    const sessions = Object.values(state.sessions)
      .map((session) => serializeSession(session, req))
      .filter((session) => !status || session.status === status)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

    res.json({ sessions });
  });

  app.get("/v1/operator/sessions/:sessionId", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    return res.json(serializeSession(session, req));
  });

  app.get("/v1/operator/sessions/:sessionId/screenshots/latest", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    if (!session.lastScreenshot?.fileName) {
      return jsonError(res, 404, "screenshot_not_found", "Screenshot was not found");
    }

    const filePath = path.join(screenshotsDir, session.lastScreenshot.fileName);
    if (!fs.existsSync(filePath)) {
      return jsonError(res, 404, "screenshot_not_found", "Screenshot file was not found");
    }

    res.setHeader("Content-Type", session.lastScreenshot.contentType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(filePath);
  });

  app.get("/v1/operator/sessions/:sessionId/messages", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    return res.json({ messages: state.messages[session.sessionId] || [] });
  });

  app.post("/v1/operator/sessions/:sessionId/messages", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }

    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return jsonError(res, 400, "invalid_message", "Message text is required");
    }

    const message = {
      messageId: createId(),
      clientMessageId: typeof req.body.clientMessageId === "string" ? req.body.clientMessageId : "",
      sessionId: session.sessionId,
      sender: "operator",
      operatorId: "operator",
      operatorDisplayName: normalizeDisplayName(req.body?.operatorDisplayName) || "Operator",
      text,
      createdAt: nowIso(),
      deliveryStatus: "queued"
    };

    state.messages[session.sessionId] ||= [];
    state.messages[session.sessionId].push(message);
    audit("operator.message", session.sessionId, message.operatorId, { messageId: message.messageId });

    const socket = extensionSockets.get(session.sessionId);
    if (socket && socket.readyState === WS_OPEN) {
      sendJson(socket, {
        type: "operator.message",
        messageId: message.messageId,
        clientMessageId: message.clientMessageId,
        operatorId: message.operatorId,
        operatorDisplayName: message.operatorDisplayName,
        text: message.text,
        createdAt: message.createdAt
      });
      message.deliveryStatus = "delivered";
    }

    save();
    broadcastOperators({
      type: "chat.message",
      sessionId: session.sessionId,
      messageId: message.messageId,
      clientMessageId: message.clientMessageId,
      sender: "operator",
      operatorDisplayName: message.operatorDisplayName,
      text: message.text,
      createdAt: message.createdAt,
      deliveryStatus: message.deliveryStatus
    });

    return res.status(201).json({
      messageId: message.messageId,
      clientMessageId: message.clientMessageId,
      sessionId: message.sessionId,
      sender: message.sender,
      operatorDisplayName: message.operatorDisplayName,
      text: message.text,
      createdAt: message.createdAt,
      deliveryStatus: message.deliveryStatus
    });
  });

  app.get("/v1/operator/sessions/:sessionId/moodle/questions", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }

    const status = typeof req.query.status === "string" ? req.query.status : "";
    const questions = getCurrentQuestions(session.sessionId, status)
      .map(serializeMoodleQuestion)
      .sort((left, right) => Date.parse(right.updatedAt || right.receivedAt || 0) - Date.parse(left.updatedAt || left.receivedAt || 0));

    return res.json({ questions });
  });

  app.get("/v1/operator/sessions/:sessionId/moodle/questions/:questionId", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    const question = getQuestion(session.sessionId, req.params.questionId);
    if (!question) {
      return jsonError(res, 404, "moodle_question_not_found", "Moodle question was not found");
    }

    return res.json(serializeMoodleQuestion(question));
  });

  app.post("/v1/operator/sessions/:sessionId/moodle/questions/:questionId/answers", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }
    const question = getQuestion(session.sessionId, req.params.questionId);
    if (!question) {
      return jsonError(res, 404, "moodle_question_not_found", "Moodle question was not found");
    }

    const rawFields = Array.isArray(req.body?.fields) ? req.body.fields : req.body?.answers;
    const fields = Array.isArray(rawFields) ? rawFields.slice(0, 400).map(normalizeAnswerField).filter((field) => (
      field.name || field.id || field.selector || field.controlId
    )) : [];
    if (!fields.length) {
      return jsonError(res, 400, "invalid_moodle_answer", "At least one answer field is required");
    }

    const answer = {
      answerId: createId(),
      questionId: question.questionId,
      clientQuestionId: question.clientQuestionId || "",
      questionFingerprint: question.questionFingerprint || "",
      applyMode: "on_hotkey",
      hotkey: MOODLE_HOTKEY,
      fields,
      submit: Boolean(req.body?.submit),
      operatorId: "operator",
      operatorDisplayName: normalizeDisplayName(req.body?.operatorDisplayName) || "Operator",
      status: "queued",
      deliveryStatus: "queued",
      createdAt: nowIso()
    };

    question.answers ||= [];
    question.answers.push(answer);
    question.latestAnswer = {
      answerId: answer.answerId,
      deliveryStatus: answer.deliveryStatus,
      status: answer.status,
      createdAt: answer.createdAt
    };
    audit("moodle.answer", session.sessionId, answer.operatorId, {
      questionId: question.questionId,
      answerId: answer.answerId,
      fieldCount: fields.length
    });

    const socket = extensionSockets.get(session.sessionId);
    if (socket && socket.readyState === WS_OPEN) {
      sendJson(socket, {
        type: "moodle.answer",
        ...serializeMoodleAnswer(answer)
      });
      answer.deliveryStatus = "delivered";
      answer.deliveredAt = nowIso();
      question.latestAnswer.deliveryStatus = answer.deliveryStatus;
      question.latestAnswer.deliveredAt = answer.deliveredAt;
    }

    save();
    broadcastOperators({
      type: "moodle.answer.submitted",
      sessionId: session.sessionId,
      questionId: question.questionId,
      answerId: answer.answerId,
      deliveryStatus: answer.deliveryStatus,
      createdAt: answer.createdAt
    });

    return res.status(201).json({
      answerId: answer.answerId,
      questionId: question.questionId,
      deliveryStatus: answer.deliveryStatus,
      hotkey: MOODLE_HOTKEY,
      createdAt: answer.createdAt
    });
  });

  app.post("/v1/operator/sessions/:sessionId/sos/clear", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }

    const clearedAt = nowIso();
    const operatorDisplayName = normalizeDisplayName(req.body?.operatorDisplayName) || "Operator";
    if (session.activeSos && !session.activeSos.clearedAt) {
      session.activeSos.clearedAt = clearedAt;
      session.activeSos.clearedByDisplayName = operatorDisplayName;
      session.lastSosClearedAt = clearedAt;
      const chatMessage = appendSystemMessage(
        session,
        "sos.cleared",
        "SOS signal was turned off",
        {
          createdAt: clearedAt,
          sosId: session.activeSos.sosId || ""
        }
      );
      audit("sos.cleared", session.sessionId, "operator", {
        sosId: session.activeSos.sosId || "",
        operatorDisplayName
      });
      save();
      broadcastSessionUpsert(session, req);
      broadcastOperators({
        type: "session.sos.cleared",
        sessionId: session.sessionId,
        sos: serializeSos(session.activeSos)
      });
      broadcastChatMessage(chatMessage);
    }

    return res.json({
      session: serializeSession(session, req),
      sos: serializeSos(session.activeSos)
    });
  });

  app.post("/v1/operator/sessions/:sessionId/commands", requireOperator, (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return jsonError(res, 404, "session_not_found", "Session was not found");
    }

    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!SUPPORTED_COMMANDS.has(name)) {
      return jsonError(res, 400, "unsupported_command", "Command is not supported by v1");
    }

    const command = {
      commandId: createId(),
      name,
      payload: req.body.payload && typeof req.body.payload === "object" ? req.body.payload : {},
      status: "queued",
      createdAt: nowIso()
    };
    session.commands ||= [];
    session.commands.push(command);
    audit("session.command", session.sessionId, "operator", {
      commandId: command.commandId,
      name
    });

    const socket = extensionSockets.get(session.sessionId);
    if (socket && socket.readyState === WS_OPEN) {
      sendJson(socket, {
        type: "session.command",
        commandId: command.commandId,
        name: command.name,
        payload: command.payload
      });
      command.status = "delivered";
    }

    save();
    return res.status(201).json({
      commandId: command.commandId,
      name: command.name,
      createdAt: command.createdAt,
      deliveryStatus: command.status === "delivered" ? "delivered" : "queued"
    });
  });

  app.use((error, _req, res, next) => {
    if (!error) {
      return next();
    }
    if (error.code === "LIMIT_FILE_SIZE") {
      return jsonError(res, 413, "payload_too_large", "Uploaded file is too large");
    }
    if (error.message === "unsupported_image_type") {
      return jsonError(res, 415, "unsupported_image_type", "Only JPEG and PNG screenshots are supported");
    }
    if (error.message === "unsupported_release_type") {
      return jsonError(res, 415, "unsupported_release_type", "Only ZIP extension release archives are supported");
    }
    console.error(error);
    return jsonError(res, 500, "internal_error", "Internal server error");
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/v1/extension/ws" && pathname !== "/v1/operator/ws") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws, req, { pathname });
    });
  });

  wsServer.on("connection", (socket, req, context) => {
    if (context.pathname === "/v1/operator/ws") {
      operatorSockets.add(socket);
      sendJson(socket, { type: "server.hello", role: "operator", serverTime: nowIso() });
      for (const session of Object.values(state.sessions)) {
        const serializedSession = serializeSession(session);
        if (serializedSession.status === "active") {
          sendJson(socket, { type: "session.upsert", session: serializedSession });
          const latestQuestion = getLatestQuestion(session.sessionId);
          if (latestQuestion) {
            sendJson(socket, {
              type: "moodle.question.upsert",
              sessionId: session.sessionId,
              question: serializeMoodleQuestion(latestQuestion)
            });
          }
        }
      }
      socket.on("close", () => {
        operatorSockets.delete(socket);
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString("utf8"));
          if (message.type === "operator.ping") {
            sendJson(socket, { type: "server.pong", serverTime: nowIso() });
          }
        } catch {
          sendJson(socket, { type: "server.error", error: { code: "invalid_json", message: "Invalid JSON" } });
        }
      });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") || "";
    const headerToken = getBearerToken(req.headers.authorization);
    let attached = false;

    const headerSession = sessionId ? getSession(sessionId) : null;
    if (headerSession && safeEqual(headerSession.extensionToken, headerToken)) {
      attached = true;
      attachExtensionSocket(socket, headerSession);
    }

    const helloTimer = setTimeout(() => {
      if (!attached) {
        socket.close(1008, "extension.hello is required");
      }
    }, 5000);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(socket, { type: "server.error", error: { code: "invalid_json", message: "Invalid JSON" } });
        return;
      }

      if (!attached) {
        if (message.type !== "extension.hello") {
          socket.close(1008, "extension.hello is required");
          return;
        }

        const helloSession = getSession(message.sessionId || sessionId);
        if (!helloSession || !safeEqual(helloSession.extensionToken, message.extensionToken)) {
          socket.close(1008, "invalid extension token");
          return;
        }

        attached = true;
        clearTimeout(helloTimer);
        attachExtensionSocket(socket, helloSession, asArray(message.capabilities));
        return;
      }

      const session = getSession(socket.remoteSessionId);
      if (!session) {
        socket.close(1008, "session not found");
        return;
      }

      if (message.type === "extension.hello") {
        sendJson(socket, {
          type: "server.hello",
          sessionId: session.sessionId,
          serverTime: nowIso()
        });
        return;
      }

      if (message.type === "chat.message") {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) {
          sendJson(socket, { type: "server.error", error: { code: "invalid_message", message: "Text is required" } });
          return;
        }
        const chatMessage = {
          messageId: createId(),
          clientMessageId: typeof message.clientMessageId === "string" ? message.clientMessageId : "",
          sessionId: session.sessionId,
          sender: "extension",
          text,
          createdAt: typeof message.createdAt === "string" ? message.createdAt : nowIso()
        };
        state.messages[session.sessionId] ||= [];
        state.messages[session.sessionId].push(chatMessage);
        save();
        broadcastOperators({
          type: "chat.message",
          sessionId: session.sessionId,
          messageId: chatMessage.messageId,
          clientMessageId: chatMessage.clientMessageId,
          sender: "extension",
          operatorDisplayName: "",
          text: chatMessage.text,
          createdAt: chatMessage.createdAt
        });
        return;
      }

      if (message.type === "command.result") {
        const commandId = typeof message.commandId === "string" ? message.commandId : "";
        const command = (session.commands || []).find((candidate) => candidate.commandId === commandId);
        if (command) {
          command.status = message.status === "error" ? "error" : "ok";
          command.result = message.payload || null;
          command.error = message.error || null;
          command.completedAt = nowIso();
          save();
        }
        broadcastOperators({
          type: "command.result",
          sessionId: session.sessionId,
          commandId,
          status: message.status === "error" ? "error" : "ok",
          payload: message.payload || null,
          error: message.error || null,
          receivedAt: nowIso()
        });
        return;
      }

      if (message.type === "moodle.answer.result") {
        const questionId = typeof message.questionId === "string" ? message.questionId : "";
        const answerId = typeof message.answerId === "string" ? message.answerId : "";
        const question = getQuestion(session.sessionId, questionId);
        const answer = question ? (question.answers || []).find((candidate) => candidate.answerId === answerId) : null;
        const status = message.status === "error" ? "error" : "ok";
        const receivedAt = nowIso();

        if (answer) {
          answer.status = status;
          answer.result = message.payload || null;
          answer.error = message.error || null;
          answer.completedAt = receivedAt;
          question.latestAnswer = {
            answerId: answer.answerId,
            deliveryStatus: answer.deliveryStatus,
            status: answer.status,
            createdAt: answer.createdAt,
            deliveredAt: answer.deliveredAt || null,
            completedAt: answer.completedAt
          };
          save();
        }

        broadcastOperators({
          type: "moodle.answer.result",
          sessionId: session.sessionId,
          questionId,
          answerId,
          status,
          payload: message.payload || null,
          error: message.error || null,
          receivedAt
        });
        return;
      }

      if (message.type === "extension.ping") {
        sendJson(socket, { type: "server.pong", serverTime: nowIso() });
        return;
      }

      sendJson(socket, {
        type: "server.error",
        error: { code: "unsupported_message", message: "Message type is not supported" }
      });
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      const session = socket.remoteSessionId ? getSession(socket.remoteSessionId) : null;
      if (session && extensionSockets.get(session.sessionId) === socket) {
        extensionSockets.delete(session.sessionId);
        broadcastSessionUpsert(session);
      }
    });
  });

  return { app, server, config, state, save };
}

function start() {
  const service = createService();
  service.server.listen(service.config.port, service.config.host, () => {
    console.log(`SEB extension server listening on ${service.config.host}:${service.config.port}`);
    console.warn("Operator API is public.");
  });
}

if (require.main === module) {
  start();
}

module.exports = { createService };

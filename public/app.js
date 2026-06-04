const OPERATOR_CLIENT_ID_KEY = "seb.operatorClientId";
const DISPLAY_NAME_KEY = "seb.displayName";
const DISPLAY_NAME_PROMPT_DISMISSED_KEY = "seb.displayNamePromptDismissed";

function getOperatorClientId() {
  const existing = localStorage.getItem(OPERATOR_CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(OPERATOR_CLIENT_ID_KEY, created);
  return created;
}

const state = {
  operatorClientId: getOperatorClientId(),
  displayName: localStorage.getItem(DISPLAY_NAME_KEY) || "",
  sessions: new Map(),
  moodleQuestions: new Map(),
  selectedSessionId: "",
  selectedMoodleQuestionId: "",
  activeSessionTab: "live",
  renderedMoodleQuestionKey: "",
  renderedMoodleQuestionId: "",
  renderedMessageKeys: new Set(),
  applyingMoodleDraft: false,
  moodleDraftTimer: null,
  lastSentMoodleDraftKey: "",
  socket: null,
  screenshotObjectUrl: ""
};

const els = {
  connectionStatus: document.getElementById("connectionStatus"),
  displayNameForm: document.getElementById("displayNameForm"),
  displayName: document.getElementById("displayName"),
  displayNamePrompt: document.getElementById("displayNamePrompt"),
  displayNamePromptDialog: document.getElementById("displayNamePromptDialog"),
  displayNamePromptClose: document.getElementById("displayNamePromptClose"),
  displayNamePromptInput: document.getElementById("displayNamePromptInput"),
  sessions: document.getElementById("sessions"),
  emptyState: document.getElementById("emptyState"),
  sessionDetail: document.getElementById("sessionDetail"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  liveTab: document.getElementById("liveTab"),
  moodleTab: document.getElementById("moodleTab"),
  liveView: document.getElementById("liveView"),
  moodleView: document.getElementById("moodleView"),
  screenshot: document.getElementById("screenshot"),
  screenshotEmpty: document.getElementById("screenshotEmpty"),
  captureNow: document.getElementById("captureNow"),
  clearSos: document.getElementById("clearSos"),
  moodleMeta: document.getElementById("moodleMeta"),
  moodleQuestionEmpty: document.getElementById("moodleQuestionEmpty"),
  moodleQuestionPane: document.getElementById("moodleQuestionPane"),
  moodleQuestionFrame: document.getElementById("moodleQuestionFrame"),
  moodleAnswerFields: document.getElementById("moodleAnswerFields"),
  sendMoodleAnswers: document.getElementById("sendMoodleAnswers"),
  moodleAnswerStatus: document.getElementById("moodleAnswerStatus"),
  messages: document.getElementById("messages"),
  messageForm: document.getElementById("messageForm"),
  messageText: document.getElementById("messageText")
};

els.displayName.value = state.displayName;

function markDisplayNamePromptHandled() {
  localStorage.setItem(DISPLAY_NAME_PROMPT_DISMISSED_KEY, "1");
}

function shouldShowDisplayNamePrompt() {
  return !state.displayName && localStorage.getItem(DISPLAY_NAME_PROMPT_DISMISSED_KEY) !== "1";
}

function hideDisplayNamePrompt({ remember = true } = {}) {
  els.displayNamePrompt.hidden = true;
  if (remember) {
    markDisplayNamePromptHandled();
  }
}

function showDisplayNamePrompt() {
  if (!shouldShowDisplayNamePrompt()) {
    return;
  }
  els.displayNamePromptInput.value = "";
  els.displayNamePrompt.hidden = false;
  window.setTimeout(() => els.displayNamePromptInput.focus(), 0);
}

function updateDisplayName(value, { syncInputs = false, rememberPrompt = false } = {}) {
  state.displayName = value.trim();
  localStorage.setItem(DISPLAY_NAME_KEY, state.displayName);
  if (syncInputs) {
    els.displayName.value = state.displayName;
    els.displayNamePromptInput.value = state.displayName;
  }
  if (state.displayName && rememberPrompt) {
    hideDisplayNamePrompt();
  }
}

if (state.displayName) {
  markDisplayNamePromptHandled();
}

function authHeaders() {
  return {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.error?.message || message;
    } catch {
      // Keep response status text.
    }
    throw new Error(message);
  }
  return response.json();
}

function formatTime(value) {
  if (!value) {
    return "never";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function renderSessions() {
  const sessions = Array.from(state.sessions.values())
    .filter((session) => session.status === "active")
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

  els.sessions.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "session-time";
    empty.textContent = "No sessions";
    els.sessions.append(empty);
    state.moodleQuestions = new Map();
    state.selectedMoodleQuestionId = "";
    renderDetail();
    renderMoodleQuestion();
    return;
  }

  if (!state.selectedSessionId || !state.sessions.has(state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.sessionId || "";
  }

  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `session-item ${session.sessionId === state.selectedSessionId ? "active" : ""} ${session.sosActive ? "sos" : ""}`;
    item.dataset.sessionId = session.sessionId;
    item.innerHTML = `
      <span class="session-line">
        <span class="session-domain">${escapeHtml(formatSessionCardTitle(session))}</span>
        ${session.sosActive ? '<span class="badge sos">SOS</span>' : ""}
      </span>
      <span class="session-time">${escapeHtml(formatSessionScreenshot(session))}</span>
    `;
    item.addEventListener("click", () => {
      state.selectedSessionId = session.sessionId;
      renderSessions();
      renderDetail();
      loadMessages().catch(showError);
      loadMoodleQuestions().catch(showError);
    });
    els.sessions.append(item);
  }

  renderDetail();
}

function renderSessionTabs() {
  const tabs = [
    { name: "live", button: els.liveTab, panel: els.liveView },
    { name: "moodle", button: els.moodleTab, panel: els.moodleView }
  ];
  for (const tab of tabs) {
    const active = state.activeSessionTab === tab.name;
    tab.button.classList.toggle("active", active);
    tab.button.setAttribute("aria-selected", active ? "true" : "false");
    tab.panel.hidden = !active;
  }
  if (state.activeSessionTab === "moodle") {
    window.setTimeout(syncMoodleAnswerFallback, 0);
  }
}

function renderDetail() {
  const session = state.sessions.get(state.selectedSessionId);
  els.emptyState.hidden = Boolean(session);
  els.sessionDetail.hidden = !session;
  renderSessionTabs();
  if (!session) {
    els.sessionDetail.classList.remove("sos-active");
    els.clearSos.hidden = true;
    state.moodleQuestions = new Map();
    state.selectedMoodleQuestionId = "";
    renderMoodleQuestion();
    return;
  }

  els.detailTitle.textContent = formatSessionTitle(session);
  const sosText = session.sosActive ? ` - SOS ${formatTime(session.sos?.sentAt || session.sos?.receivedAt)}` : "";
  els.detailMeta.textContent = `${session.status}${sosText} - started ${formatTime(session.startedAt)} - ${session.currentUrl || "no url"}`;
  els.sessionDetail.classList.toggle("sos-active", Boolean(session.sosActive));
  els.clearSos.hidden = !session.sosActive;

  if (session.lastScreenshotUrl) {
    els.screenshot.hidden = false;
    els.screenshotEmpty.hidden = true;
    loadScreenshot(session).catch(showError);
  } else {
    if (state.screenshotObjectUrl) {
      URL.revokeObjectURL(state.screenshotObjectUrl);
      state.screenshotObjectUrl = "";
    }
    els.screenshot.removeAttribute("src");
    els.screenshot.hidden = true;
    els.screenshotEmpty.hidden = false;
  }
  renderMoodleQuestion();
}

async function loadScreenshot(session) {
  const selectedId = session.sessionId;
  const response = await fetch(`${session.lastScreenshotUrl}?t=${Date.now()}`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  if (selectedId !== state.selectedSessionId) {
    return;
  }
  if (state.screenshotObjectUrl) {
    URL.revokeObjectURL(state.screenshotObjectUrl);
  }
  state.screenshotObjectUrl = URL.createObjectURL(blob);
  els.screenshot.src = state.screenshotObjectUrl;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadSessions() {
  const payload = await api("/v1/operator/sessions?status=active");
  state.sessions = new Map(payload.sessions.map((session) => [session.sessionId, session]));
  renderSessions();
}

async function loadMessages() {
  if (!state.selectedSessionId) {
    return;
  }
  const payload = await api(`/v1/operator/sessions/${state.selectedSessionId}/messages`);
  resetMessages();
  for (const message of payload.messages) {
    appendMessage(message);
  }
}

async function loadMoodleQuestions() {
  if (!state.selectedSessionId) {
    return;
  }
  const payload = await api(`/v1/operator/sessions/${state.selectedSessionId}/moodle/questions`);
  const currentQuestion = payload.questions[0] || null;
  state.moodleQuestions = currentQuestion
    ? new Map([[currentQuestion.questionId, currentQuestion]])
    : new Map();
  state.selectedMoodleQuestionId = currentQuestion?.questionId || "";
  renderMoodleQuestion();
}

function getSelectedMoodleQuestion() {
  const questions = Array.from(state.moodleQuestions.values())
    .sort((left, right) => Date.parse(right.updatedAt || right.receivedAt || 0) - Date.parse(left.updatedAt || left.receivedAt || 0));
  const question = state.moodleQuestions.get(state.selectedMoodleQuestionId) || questions[0] || null;
  if (question && state.selectedMoodleQuestionId !== question.questionId) {
    state.selectedMoodleQuestionId = question.questionId;
  }
  return question;
}

function getMoodleQuestionRenderKey(question) {
  return [
    question.questionId || "",
    question.clientQuestionId || "",
    question.questionFingerprint || "",
    question.questionType || "",
    question.html || "",
    JSON.stringify(question.controls || [])
  ].join("\n");
}

function renderMoodleQuestion() {
  const session = state.sessions.get(state.selectedSessionId);
  const question = getSelectedMoodleQuestion();

  els.moodleQuestionEmpty.hidden = Boolean(question);
  els.moodleQuestionPane.hidden = !question;
  els.sendMoodleAnswers.disabled = !question;
  if (!session || !question) {
    els.moodleMeta.textContent = "No question yet";
    els.moodleAnswerStatus.textContent = "";
    els.moodleQuestionFrame.removeAttribute("srcdoc");
    els.moodleAnswerFields.innerHTML = "";
    els.moodleAnswerFields.hidden = false;
    state.renderedMoodleQuestionKey = "";
    state.renderedMoodleQuestionId = "";
    state.lastSentMoodleDraftKey = "";
    return;
  }

  els.moodleMeta.textContent = [
    question.questionType || "moodle",
    question.questionNumber ? `#${question.questionNumber}` : "",
    formatTime(question.updatedAt || question.receivedAt)
  ].filter(Boolean).join(" - ");
  els.moodleAnswerStatus.textContent = question.latestAnswer
    ? `last answer ${question.latestAnswer.status || question.latestAnswer.deliveryStatus}`
    : "";
  const renderKey = getMoodleQuestionRenderKey(question);
  const sameRenderedQuestion = state.renderedMoodleQuestionId === question.questionId
    && Boolean(state.renderedMoodleQuestionKey);
  if (sameRenderedQuestion) {
    if (question.latestDraft?.operatorClientId !== state.operatorClientId) {
      applyMoodleDraft(question.latestDraft, { preserveActiveElement: true });
    }
    syncMoodleAnswerFallback();
    return;
  }
  if (state.renderedMoodleQuestionKey === renderKey) {
    if (question.latestDraft?.operatorClientId !== state.operatorClientId) {
      applyMoodleDraft(question.latestDraft, { preserveActiveElement: true });
    }
    syncMoodleAnswerFallback();
    return;
  }
  state.renderedMoodleQuestionKey = renderKey;
  state.renderedMoodleQuestionId = question.questionId;
  state.lastSentMoodleDraftKey = "";
  els.moodleQuestionFrame.srcdoc = buildMoodleQuestionDocument(question);
  renderMoodleAnswerFields(question);
  applyMoodleDraftToEditorOnly(question.latestDraft);
  syncMoodleAnswerFallback();
}

function getMoodleQuestionBodyHtml(question) {
  if (question.html) {
    try {
      const parsed = new DOMParser().parseFromString(question.html, "text/html");
      sanitizeMoodleQuestionDocument(parsed);
      const parsedBody = parsed.body?.innerHTML?.trim();
      if (parsedBody) {
        return parsedBody;
      }
    } catch {
      return question.html;
    }
    return question.html;
  }

  return `
    <div class="que">
      <div class="content">
        <div class="formulation">
          <div class="qtext">${escapeHtml(question.text || "")}</div>
        </div>
      </div>
    </div>
  `;
}

function sanitizeMoodleQuestionDocument(parsed) {
  parsed.querySelectorAll("script").forEach((element) => element.remove());
  replaceUnsupportedMoodleMedia(parsed);
}

function replaceUnsupportedMoodleMedia(parsed) {
  const mediaRootSelector = [
    ".mediaplugin",
    ".mediaplugin_audio",
    ".mediaplugin_videojs",
    ".mediaelement",
    ".mediaelement-audio",
    ".mediaelement-video",
    ".mejs-container",
    ".mejs__container",
    ".moodle-media-player",
    ".video-js",
    ".vjs-audio",
    ".vjs-video",
    "[id^='mep_']"
  ].join(", ");
  const mediaSelector = [
    "audio",
    "video",
    mediaRootSelector,
    "[class*='mejs__']",
    "[class*='mediaelement']",
    "[class*='mediaplugin']"
  ].join(", ");
  const roots = [];
  for (const element of parsed.querySelectorAll(mediaSelector)) {
    const root = findUnsupportedMediaRoot(element, mediaRootSelector);
    if (root && !roots.some((candidate) => candidate.contains(root))) {
      for (let index = roots.length - 1; index >= 0; index -= 1) {
        if (root.contains(roots[index])) {
          roots.splice(index, 1);
        }
      }
      roots.push(root);
    }
  }

  for (const root of roots) {
    if (!root.isConnected) {
      continue;
    }
    root.replaceWith(createUnsupportedAudioPlaceholder(parsed, root));
  }

  parsed.querySelectorAll("[class*='mejs__'], [class*='mediaelement'], [class*='mediaplugin']").forEach((element) => {
    if (looksLikeMediaControlText(element.textContent || "")) {
      element.remove();
    }
  });
  parsed.querySelectorAll("[role='dialog'], .modal, .moodle-dialogue, .moodle-dialogue-base").forEach((element) => {
    if (looksLikeMediaControlText(element.textContent || "")) {
      element.remove();
    }
  });
}

function findUnsupportedMediaRoot(element, mediaRootSelector) {
  let root = element;
  for (let current = element; current && current.parentElement; current = current.parentElement) {
    if (current.matches(mediaRootSelector)) {
      root = current;
    }
  }
  return root;
}

function createUnsupportedAudioPlaceholder(parsed, mediaRoot) {
  const placeholder = parsed.createElement("div");
  placeholder.className = "unsupported-audio-placeholder";
  placeholder.setAttribute("role", "note");
  const duration = extractMediaDuration(mediaRoot.textContent || "");
  const title = parsed.createElement("strong");
  title.textContent = duration ? `Audio recording - ${duration}` : "Audio recording";
  const note = parsed.createElement("span");
  note.textContent = "Playback is not available on this site.";
  placeholder.append(title, note);
  return placeholder;
}

function extractMediaDuration(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const labeled = normalized.match(/(?:duration|продолжительность)\D{0,40}((?:\d{1,2}:)?\d{1,2}:\d{2})/i);
  if (labeled) {
    return labeled[1];
  }

  let best = "";
  let bestSeconds = -1;
  const matches = normalized.matchAll(/(^|[^\d-])((?:\d{1,2}:)?\d{1,2}:\d{2})(?!\d)/g);
  for (const match of matches) {
    const seconds = timeTextToSeconds(match[2]);
    if (seconds > bestSeconds) {
      best = match[2];
      bestSeconds = seconds;
    }
  }
  return best;
}

function timeTextToSeconds(value) {
  return String(value || "")
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
    .reduce((total, part) => (total * 60) + part, 0);
}

function looksLikeMediaControlText(text) {
  return /(?:video player|audio|видеоплеер|воспроизвести|продолжительность|субтитр|звуковая дорожка|picture in picture|playback speed|this is a modal window|caption area)/i
    .test(String(text || ""));
}

function buildMoodleQuestionDocument(question) {
  const baseHref = question.baseUrl || question.pageUrl || "";
  const body = getMoodleQuestionBodyHtml(question);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base href="${escapeAttribute(baseHref)}">
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background: #f7f8fa;
        color: #1d2125;
        font: 15px/1.5 Arial, "Helvetica Neue", sans-serif;
      }
      .moodle-question-root {
        min-height: 100vh;
        padding: 18px;
      }
      img, video {
        max-width: 100%;
        height: auto;
      }
      audio {
        width: 100%;
        max-width: 420px;
      }
      .unsupported-audio-placeholder {
        display: inline-grid;
        gap: 0.2rem;
        max-width: 28rem;
        margin: 0.75rem 0 1rem;
        padding: 0.75rem 0.9rem;
        border: 1px solid #ced4da;
        border-radius: 6px;
        background: #ffffff;
        color: #495057;
      }
      .unsupported-audio-placeholder strong {
        color: #1d2125;
      }
      table {
        max-width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 0.45rem 0.55rem;
        border: 1px solid #dee2e6;
        vertical-align: top;
      }
      input, select, textarea, button {
        font: inherit;
      }
      input:not([type]),
      input[type="text"],
      input[type="number"],
      input[type="email"],
      input[type="search"],
      select,
      textarea {
        max-width: 100%;
        min-height: 36px;
        border: 1px solid #8f959e;
        border-radius: 4px;
        background: #ffffff;
        color: #1d2125;
        padding: 0.35rem 0.55rem;
      }
      textarea {
        min-height: 92px;
        resize: vertical;
      }
      input[type="radio"],
      input[type="checkbox"] {
        width: auto;
        min-height: 0;
        margin: 0.2rem 0.45rem 0.2rem 0;
        vertical-align: middle;
      }
      label {
        cursor: pointer;
      }
      .que {
        width: min(100%, 1080px);
        margin: 0 auto 1rem;
        display: grid;
        grid-template-columns: minmax(112px, 8.5rem) minmax(0, 1fr);
        gap: 1rem;
      }
      .que .info {
        align-self: start;
        border: 1px solid #dee2e6;
        border-radius: 4px;
        background: #ffffff;
        color: #495057;
        padding: 0.75rem;
        font-size: 0.875rem;
      }
      .que .info .no,
      .que .info .state,
      .que .info .grade {
        margin: 0 0 0.35rem;
      }
      .que .content {
        min-width: 0;
      }
      .que .formulation,
      .que .outcome,
      .que .comment,
      .que .history,
      .que .im-controls {
        border: 1px solid #dee2e6;
        border-radius: 4px;
        background: #ffffff;
        padding: 1rem;
        margin: 0 0 1rem;
      }
      .que .formulation {
        background: #f8fbff;
        border-color: #cfe2ff;
      }
      .qtext {
        margin: 0 0 1rem;
        font-size: 1rem;
      }
      .ablock,
      .answer {
        margin: 0.85rem 0 0;
      }
      .answer .r0,
      .answer .r1,
      .answer > div,
      .subquestion {
        margin: 0.35rem 0;
        padding: 0.38rem 0.5rem;
        border-radius: 4px;
      }
      .answer .r0:hover,
      .answer .r1:hover,
      .answer > div:hover,
      .subquestion:hover {
        background: rgba(13, 110, 253, 0.06);
      }
      .prompt,
      .specificfeedback,
      .generalfeedback,
      .rightanswer {
        color: #495057;
        margin: 0.5rem 0;
      }
      .accesshide,
      .sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
      }
      .d-flex { display: flex; }
      .flex-wrap { flex-wrap: wrap; }
      .align-items-center { align-items: center; }
      .gap-1 { gap: 0.25rem; }
      .gap-2 { gap: 0.5rem; }
      .draghome,
      .drag,
      .dragitem,
      .draggable,
      .dragproxy,
      .place,
      .drop,
      .dropzone {
        display: inline-block;
        min-width: 2.5rem;
        min-height: 2rem;
        margin: 0.2rem;
        padding: 0.35rem 0.55rem;
        border: 1px solid #adb5bd;
        border-radius: 4px;
        background: #ffffff;
        vertical-align: middle;
      }
      .drag,
      .dragitem,
      .draggable,
      [draggable="true"] {
        cursor: grab;
        user-select: none;
      }
      .drag.moodle-drag-selected,
      .dragitem.moodle-drag-selected,
      .draggable.moodle-drag-selected,
      .seb-moodle-synthetic-drag.moodle-drag-selected {
        outline: 2px solid #0d6efd;
        outline-offset: 2px;
      }
      .drag.moodle-dragging,
      .dragitem.moodle-dragging,
      .draggable.moodle-dragging,
      .seb-moodle-synthetic-drag.moodle-dragging {
        cursor: grabbing;
        opacity: 0.65;
      }
      .drop,
      .dropzone,
      .place {
        border-style: dashed;
        background: #f1f3f5;
      }
      .drop.moodle-drop-active,
      .dropzone.moodle-drop-active,
      .place.moodle-drop-active {
        border-color: #0d6efd;
        background: #e7f1ff;
      }
      .drop.moodle-drop-filled,
      .dropzone.moodle-drop-filled,
      .place.moodle-drop-filled {
        border-style: solid;
        background: #ffffff;
      }
      .seb-moodle-raw-drag-hidden,
      .seb-moodle-hidden-drag-home {
        display: none !important;
      }
      .seb-moodle-drop-normalized {
        display: inline-flex !important;
        align-items: stretch;
        justify-content: center;
        min-width: 13.5rem;
        min-height: 2.25rem;
        padding: 0 !important;
        overflow: hidden;
        line-height: 1.35;
        vertical-align: middle;
      }
      td .seb-moodle-drop-normalized,
      th .seb-moodle-drop-normalized {
        width: min(100%, 13.5rem);
      }
      .seb-moodle-drag-bank {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        margin: 1rem 0 0;
      }
      .seb-moodle-drag-bank[hidden] {
        display: none !important;
      }
      .seb-moodle-synthetic-drag {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.15rem;
        min-width: 10rem;
        padding: 0.35rem 0.75rem;
        border: 1px solid #8f959e;
        border-radius: 4px;
        background: #ffffff;
        color: #1d2125;
        cursor: grab;
        line-height: 1.35;
        text-align: center;
        user-select: none;
      }
      .seb-moodle-source-drag {
        flex: 0 1 14rem;
      }
      .seb-moodle-placed-drag {
        display: flex !important;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        width: 100%;
        height: auto;
        max-width: 100%;
        min-width: 0;
        min-height: 100%;
        margin: 0 !important;
        border: 0;
        border-radius: 3px;
        box-shadow: none;
        cursor: grab;
        position: static !important;
        transform: none !important;
      }
      .matching select,
      .match select,
      .multianswer select {
        min-width: 12rem;
      }
      .correct,
      .rightanswer {
        border-color: #badbcc;
        background: #f0fff4;
      }
      .incorrect {
        border-color: #f1aeb5;
        background: #fff5f5;
      }
      @media (max-width: 760px) {
        .moodle-question-root { padding: 12px; }
        .que {
          grid-template-columns: 1fr;
          gap: 0.6rem;
        }
      }
    </style>
  </head>
  <body><main class="moodle-question-root">${body}</main></body>
</html>`;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function renderMoodleAnswerFields(question) {
  els.moodleAnswerFields.hidden = false;
  els.moodleAnswerFields.innerHTML = "";
  const controls = Array.isArray(question.controls) ? question.controls.filter((control) => (
    control && (control.name || control.id || control.controlId)
  )) : [];

  if (!controls.length) {
    const empty = document.createElement("p");
    empty.className = "session-time";
    empty.textContent = "No answer fields";
    els.moodleAnswerFields.append(empty);
    return;
  }

  const groups = new Map();
  for (const control of controls) {
    const key = control.name || control.id || control.controlId;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(control);
  }

  for (const group of groups.values()) {
    const control = group[0];
    const type = (control.type || "text").toLowerCase();
    if (type === "radio") {
      els.moodleAnswerFields.append(renderRadioControl(group));
      continue;
    }
    if (type === "checkbox") {
      for (const checkbox of group) {
        els.moodleAnswerFields.append(renderCheckboxControl(checkbox));
      }
      continue;
    }
    if (type === "select" || type === "select-one" || type === "select-multiple") {
      els.moodleAnswerFields.append(renderSelectControl(control));
      continue;
    }
    if (type === "textarea") {
      els.moodleAnswerFields.append(renderTextControl(control, true));
      continue;
    }
    els.moodleAnswerFields.append(renderTextControl(control, false));
  }
}

function renderControlLabel(control) {
  return control.label || control.name || control.id || control.controlId || "answer";
}

function applyControlDataset(element, control) {
  element.dataset.controlId = control.controlId || "";
  element.dataset.id = control.id || "";
  element.dataset.selector = control.selector || "";
  element.dataset.type = control.type || element.type || element.tagName.toLowerCase();
}

function renderSelectControl(control) {
  const wrapper = document.createElement("div");
  wrapper.className = "moodle-answer-field";
  const label = document.createElement("label");
  const id = `answer-${crypto.randomUUID()}`;
  label.setAttribute("for", id);
  label.textContent = renderControlLabel(control);
  const select = document.createElement("select");
  select.id = id;
  select.name = control.name || control.id || control.controlId;
  applyControlDataset(select, control);
  for (const option of control.options || []) {
    const optionElement = document.createElement("option");
    optionElement.value = option.value || "";
    optionElement.textContent = option.label || option.value || "";
    optionElement.selected = Boolean(option.selected);
    optionElement.disabled = Boolean(option.disabled);
    select.append(optionElement);
  }
  if (!(control.options || []).length && control.value) {
    const optionElement = document.createElement("option");
    optionElement.value = control.value;
    optionElement.textContent = control.value;
    optionElement.selected = true;
    select.append(optionElement);
  }
  wrapper.append(label, select);
  return wrapper;
}

function renderTextControl(control, multiline) {
  const wrapper = document.createElement("div");
  wrapper.className = "moodle-answer-field";
  const label = document.createElement("label");
  const id = `answer-${crypto.randomUUID()}`;
  label.setAttribute("for", id);
  label.textContent = renderControlLabel(control);
  const input = multiline ? document.createElement("textarea") : document.createElement("input");
  input.id = id;
  input.name = control.name || control.id || control.controlId;
  if (!multiline) {
    input.type = "text";
  }
  input.value = control.value || "";
  applyControlDataset(input, control);
  wrapper.append(label, input);
  return wrapper;
}

function renderRadioControl(group) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "moodle-radio-group";
  const legend = document.createElement("legend");
  legend.textContent = renderControlLabel(group[0]);
  fieldset.append(legend);
  const options = group.flatMap((control) => (
    control.options && control.options.length ? control.options : [{
      value: control.value || "",
      label: control.label || control.value || control.id || "option",
      checked: control.checked
    }]
  ));
  const groupName = group[0].name || group[0].id || group[0].controlId || crypto.randomUUID();
  for (const option of options) {
    const label = document.createElement("label");
    label.className = "moodle-radio-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = option.value || "";
    input.checked = Boolean(option.checked || option.selected);
    applyControlDataset(input, group[0]);
    const text = document.createElement("span");
    text.textContent = option.label || option.value || "option";
    label.append(input, text);
    fieldset.append(label);
  }
  return fieldset;
}

function renderCheckboxControl(control) {
  const label = document.createElement("label");
  label.className = "moodle-checkbox-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = control.name || control.id || control.controlId;
  input.value = control.value || "1";
  input.checked = Boolean(control.checked);
  applyControlDataset(input, control);
  const text = document.createElement("span");
  text.textContent = renderControlLabel(control);
  label.append(input, text);
  return label;
}

function isMoodleHousekeepingField(name, type) {
  return !name
    || type === "submit"
    || type === "button"
    || type === "reset"
    || type === "file"
    || /(:flagged|:sequencecheck|^attempt$|^thispage$|^nextpage$|^timeup$|^sesskey$|^mdlscrollto$|^slots$|^previous$|^next$)/.test(name);
}

function collectMoodleAnswerFields() {
  const frameFields = collectMoodleFrameAnswerFields();
  if (frameFields.length) {
    return frameFields;
  }
  return collectMoodleEditorAnswerFields();
}

function getMoodleFrameAnswerElements() {
  const frameDocument = els.moodleQuestionFrame.contentDocument;
  if (!frameDocument) {
    return [];
  }
  return Array.from(frameDocument.querySelectorAll("input[name], select[name], textarea[name]"))
    .filter((element) => {
      const tagName = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") || tagName).toLowerCase();
      const name = element.getAttribute("name") || "";
      return !element.disabled && !isMoodleHousekeepingField(name, type);
    });
}

function hasMoodleFrameDragDrop(frameDocument) {
  return Boolean(frameDocument && getMoodleDragItems(frameDocument).length && getMoodleDropTargets(frameDocument).length);
}

function syncMoodleAnswerFallback() {
  const frameDocument = els.moodleQuestionFrame.contentDocument;
  els.moodleAnswerFields.hidden = getMoodleFrameAnswerElements().length > 0 || hasMoodleFrameDragDrop(frameDocument);
}

function prepareMoodleQuestionFrame() {
  const frameDocument = els.moodleQuestionFrame.contentDocument;
  if (!frameDocument) {
    return;
  }
  normalizeMoodleFrameDragDrop(frameDocument, getSelectedMoodleQuestion());
  attachMoodleFrameDraftListeners(frameDocument);
  applyMoodleDraft(getSelectedMoodleQuestion()?.latestDraft);
  syncMoodleAnswerFallback();
}

function normalizeMoodleFrameDragDrop(frameDocument, question) {
  if (!frameDocument.body || frameDocument.body.dataset.sebMoodleDragReady === "true") {
    return;
  }
  frameDocument.body.dataset.sebMoodleDragReady = "true";

  const dropTargets = getMoodleDropTargets(frameDocument);
  if (!dropTargets.length) {
    return;
  }

  const choices = collectMoodleDragChoices(frameDocument, question);
  if (!choices.length) {
    return;
  }

  hideMoodleRawDragSources(frameDocument);
  for (const drop of dropTargets) {
    normalizeMoodleDropTarget(frameDocument, drop, choices);
  }
  renderMoodleDragBank(frameDocument, choices);
  initializeMoodleFrameDragDrop(frameDocument);
}

function collectMoodleDragChoices(frameDocument, question) {
  const choices = [];
  const appendChoice = (rawChoice) => {
    const text = normalizeMoodleChoiceText(rawChoice.text || rawChoice.value);
    if (!text || looksLikeMoodlePlaceholderChoice(text)) {
      return;
    }
    const value = String(rawChoice.value || text).trim();
    const group = String(rawChoice.group || "1").trim() || "1";
    choices.push({
      value,
      group,
      text,
      html: rawChoice.html || escapeHtml(text)
    });
  };

  for (const drag of getMoodleDragItems(frameDocument).filter((element) => !element.classList.contains("seb-moodle-synthetic-drag"))) {
    appendChoice({
      value: getMoodleDragValue(drag),
      group: getMoodleDragGroup(drag),
      text: drag.textContent,
      html: drag.innerHTML.trim() || escapeHtml(drag.textContent.trim())
    });
  }

  for (const choice of getMoodleSyntheticDragChoices(question)) {
    appendChoice(choice);
  }

  const seen = new Set();
  return choices.filter((choice) => {
    const key = `${choice.group}::${normalizeMoodleChoiceText(choice.text).toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hideMoodleRawDragSources(frameDocument) {
  for (const drag of getMoodleDragItems(frameDocument)) {
    if (!drag.classList.contains("seb-moodle-synthetic-drag")) {
      drag.classList.add("seb-moodle-raw-drag-hidden");
    }
  }

  frameDocument.querySelectorAll(".answercontainer, [class*='draggrouphomes'], .draghomes").forEach((element) => {
    if (element.querySelector(".seb-moodle-raw-drag-hidden")) {
      element.classList.add("seb-moodle-hidden-drag-home");
    }
  });
}

function normalizeMoodleDropTarget(frameDocument, drop, choices) {
  ensureMoodleElementId(drop, "drop-target");
  drop.classList.add("seb-moodle-drop-normalized");
  drop.setAttribute("tabindex", drop.getAttribute("tabindex") || "0");
  drop.setAttribute("role", drop.getAttribute("role") || "button");

  const fields = findMoodleDropFields(frameDocument, drop);
  const currentValue = fields.map((field) => field.value).find((value) => value && value !== "0") || "";
  if (!currentValue) {
    return;
  }

  const group = getMoodleDropGroup(drop);
  const choice = choices.find((candidate) => (
    candidate.value === currentValue && (!group || candidate.group === group)
  )) || choices.find((candidate) => candidate.value === currentValue);
  if (choice) {
    const card = createMoodleDragCard(frameDocument, choice, true);
    drop.append(card);
    drop.classList.add("moodle-drop-filled");
    drop.dataset.sebDropValue = choice.value;
    drop.dataset.sebDropText = choice.text;
  }
}

function renderMoodleDragBank(frameDocument, choices) {
  frameDocument.querySelectorAll("[data-seb-drag-bank='true']").forEach((element) => element.remove());
  const bank = frameDocument.createElement("div");
  bank.className = "seb-moodle-drag-bank";
  bank.dataset.sebDragBank = "true";
  bank.setAttribute("aria-label", "Drag choices");

  for (const choice of choices) {
    bank.append(createMoodleDragCard(frameDocument, choice, false));
  }

  const anchor = frameDocument.querySelector(".answer, .ablock, .formulation, .content, .moodle-question-root")
    || frameDocument.body;
  anchor.append(bank);
}

function createMoodleDragCard(frameDocument, choice, placed) {
  const card = frameDocument.createElement("span");
  card.className = placed
    ? "seb-moodle-synthetic-drag seb-moodle-placed-drag moodle-drag-card"
    : "seb-moodle-synthetic-drag seb-moodle-source-drag moodle-drag-card";
  card.draggable = true;
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.dataset.value = choice.value;
  card.dataset.dragid = choice.value;
  card.dataset.choice = choice.value;
  card.dataset.group = choice.group || "1";
  card.dataset.text = choice.text;
  card.innerHTML = choice.html || escapeHtml(choice.text);
  ensureMoodleElementId(card, placed ? "placed-card" : "source-card");
  return card;
}

function getMoodleSyntheticDragChoices(question) {
  if (!question || !looksLikeMoodleDragQuestion(question)) {
    return [];
  }

  const choices = [];
  const appendChoice = (rawValue, rawText) => {
    const text = normalizeMoodleChoiceText(rawText || rawValue);
    if (!text || looksLikeMoodlePlaceholderChoice(text)) {
      return;
    }
    const value = String(rawValue || text).trim();
    choices.push({ value, text, group: "1", html: escapeHtml(text) });
  };

  for (const control of Array.isArray(question.controls) ? question.controls : []) {
    if (!control) {
      continue;
    }
    const type = String(control.type || "").toLowerCase();
    if (Array.isArray(control.options) && control.options.length) {
      for (const option of control.options) {
        if (option?.disabled) {
          continue;
        }
        appendChoice(option?.value || option?.label || option?.html, option?.label || option?.html || option?.value);
      }
      continue;
    }

    if (["dragdrop", "drag", "drop", "choice", "hidden", "text", "input", ""].includes(type)) {
      const label = control.label || control.labelHtml || "";
      const text = label || control.value || "";
      if (text) {
        appendChoice(control.value || text, text);
      }
    }
  }

  const seen = new Set();
  return choices.filter((choice) => {
    const key = normalizeMoodleChoiceText(choice.text).toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function looksLikeMoodleDragQuestion(question) {
  const type = String(question.questionType || "").toLowerCase();
  const html = String(question.html || "").toLowerCase();
  return /(?:ddwtos|ddimageortext|ddmarker|drag|drop)/.test(type)
    || /(?:class=["'][^"']*(?:drop|dropzone|place|droptarget|drag|dragitem|draggable)|data-(?:dropzone|place|dragid|choice|value))/.test(html)
    || (Array.isArray(question.controls) && question.controls.some((control) => (
      /(?:drag|drop|choice)/.test(String(control.type || "").toLowerCase())
    )));
}

function normalizeMoodleChoiceText(value) {
  const parsed = new DOMParser().parseFromString(String(value || ""), "text/html");
  return (parsed.body?.textContent || String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMoodlePlaceholderChoice(text) {
  return !text
    || /^[\d:._\-[\]]+$/.test(text)
    || /^(?:0|none|choose|select|answer|option|drop|drag)$/i.test(text)
    || /^q\d+:\d+/i.test(text);
}

function initializeMoodleFrameDragDrop(frameDocument) {
  if (!frameDocument.body || frameDocument.body.dataset.sebMoodleDragEventsReady === "true") {
    return;
  }
  frameDocument.body.dataset.sebMoodleDragEventsReady = "true";
  let selectedDrag = null;

  frameDocument.body.addEventListener("dragstart", (event) => {
    const drag = getClosestMoodleInteractiveDrag(event.target);
    if (!drag) {
      return;
    }
    selectedDrag = drag;
    markSelectedMoodleDrag(frameDocument, selectedDrag);
    drag.classList.add("moodle-dragging");
    event.dataTransfer?.setData("text/plain", drag.id || getMoodleDragValue(drag));
    event.dataTransfer?.setData("application/x-seb-moodle-drag-id", drag.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copyMove";
    }
  });

  frameDocument.body.addEventListener("dragend", (event) => {
    const drag = getClosestMoodleInteractiveDrag(event.target);
    drag?.classList.remove("moodle-dragging");
    clearActiveMoodleDrops(frameDocument);
  });

  frameDocument.body.addEventListener("dragover", (event) => {
    const drop = getClosestMoodleDropTarget(event.target);
    if (!drop) {
      return;
    }
    event.preventDefault();
    drop.classList.add("moodle-drop-active");
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });

  frameDocument.body.addEventListener("dragleave", (event) => {
    const drop = getClosestMoodleDropTarget(event.target);
    drop?.classList.remove("moodle-drop-active");
  });

  frameDocument.body.addEventListener("drop", (event) => {
    const drop = getClosestMoodleDropTarget(event.target);
    if (!drop) {
      return;
    }
    event.preventDefault();
    const dragId = event.dataTransfer?.getData("application/x-seb-moodle-drag-id") || "";
    const drag = dragId ? frameDocument.getElementById(dragId) : selectedDrag;
    placeMoodleDragCard(frameDocument, drag, drop);
    selectedDrag = null;
    markSelectedMoodleDrag(frameDocument, selectedDrag);
    clearActiveMoodleDrops(frameDocument);
  });

  frameDocument.body.addEventListener("click", (event) => {
    const drag = getClosestMoodleInteractiveDrag(event.target);
    if (drag) {
      event.preventDefault();
      selectedDrag = selectedDrag === drag ? null : drag;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
      return;
    }

    const drop = getClosestMoodleDropTarget(event.target);
    if (drop && selectedDrag) {
      event.preventDefault();
      placeMoodleDragCard(frameDocument, selectedDrag, drop);
      selectedDrag = null;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
    }
  });

  frameDocument.body.addEventListener("keydown", (event) => {
    const drag = getClosestMoodleInteractiveDrag(event.target);
    if (drag) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectedDrag = selectedDrag === drag ? null : drag;
        markSelectedMoodleDrag(frameDocument, selectedDrag);
      }
      return;
    }

    const drop = getClosestMoodleDropTarget(event.target);
    if (!drop) {
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && selectedDrag) {
      event.preventDefault();
      placeMoodleDragCard(frameDocument, selectedDrag, drop);
      selectedDrag = null;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      clearMoodleDropAnswer(frameDocument, drop);
    }
  });

  for (const drag of frameDocument.querySelectorAll(".moodle-drag-card")) {
    if (drag.dataset.sebDirectDragReady === "true") {
      continue;
    }
    drag.dataset.sebDirectDragReady = "true";
    drag.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedDrag = selectedDrag === drag ? null : drag;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
    });
    drag.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectedDrag = selectedDrag === drag ? null : drag;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
    });
    drag.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      selectedDrag = drag;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
      drag.classList.add("moodle-dragging");
      event.dataTransfer?.setData("text/plain", drag.id || getMoodleDragValue(drag));
      event.dataTransfer?.setData("application/x-seb-moodle-drag-id", drag.id);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copyMove";
      }
    });
    drag.addEventListener("dragend", (event) => {
      event.stopPropagation();
      drag.classList.remove("moodle-dragging");
      clearActiveMoodleDrops(frameDocument);
    });
  }

  for (const drop of getMoodleDropTargets(frameDocument)) {
    if (drop.dataset.sebDirectDropReady === "true") {
      continue;
    }
    drop.dataset.sebDirectDropReady = "true";
    drop.addEventListener("click", (event) => {
      if (!selectedDrag) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      placeMoodleDragCard(frameDocument, selectedDrag, drop);
      selectedDrag = null;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
    });
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      drop.classList.add("moodle-drop-active");
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dragId = event.dataTransfer?.getData("application/x-seb-moodle-drag-id") || "";
      const drag = dragId ? frameDocument.getElementById(dragId) : selectedDrag;
      placeMoodleDragCard(frameDocument, drag, drop);
      selectedDrag = null;
      markSelectedMoodleDrag(frameDocument, selectedDrag);
      clearActiveMoodleDrops(frameDocument);
    });
  }
}

function getMoodleDragItems(frameDocument) {
  return Array.from(frameDocument.querySelectorAll([
    ".draghome",
    ".drag",
    ".dragitem",
    ".draggable",
    "[data-dragid]",
    "[data-choice]",
    "[draggable='true']"
  ].join(", "))).filter((element) => (
    !isMoodleDropTarget(element)
    && !(element.matches(".draghome") && element.querySelector(".drag, .dragitem, .draggable, [data-dragid], [data-choice], [draggable='true']"))
    && !element.matches(".dragproxy, input, select, textarea, button")
    && element.textContent.trim()
  ));
}

function getMoodleDropTargets(frameDocument) {
  return Array.from(frameDocument.querySelectorAll([
    ".drop",
    ".dropzone",
    ".place",
    ".droptarget",
    "[data-dropzone]",
    "[data-place]"
  ].join(", "))).filter((element) => (
    !isMoodleDragItem(element)
    && !element.matches("input, select, textarea, button")
  ));
}

function isMoodleDragItem(element) {
  return element.matches(".draghome, .drag, .dragitem, .draggable, [data-dragid], [data-choice], [draggable='true']");
}

function isMoodleDropTarget(element) {
  return element.matches(".drop, .dropzone, .place, .droptarget, [data-dropzone], [data-place]");
}

function getClosestMoodleInteractiveDrag(target) {
  return target?.closest?.(".moodle-drag-card") || null;
}

function getClosestMoodleDropTarget(target) {
  return target?.closest?.(".seb-moodle-drop-normalized, .drop, .dropzone, .place, .droptarget, [data-dropzone], [data-place]") || null;
}

function ensureMoodleElementId(element, prefix) {
  if (!element) {
    return "";
  }
  if (!element.id) {
    element.id = `${prefix}-${crypto.randomUUID()}`;
  }
  return element.id;
}

function markSelectedMoodleDrag(frameDocument, selectedDrag) {
  for (const drag of frameDocument.querySelectorAll(".moodle-drag-card")) {
    drag.classList.toggle("moodle-drag-selected", drag === selectedDrag);
  }
}

function clearActiveMoodleDrops(frameDocument) {
  for (const drop of getMoodleDropTargets(frameDocument)) {
    drop.classList.remove("moodle-drop-active");
  }
}

function placeMoodleDragCard(frameDocument, drag, drop) {
  if (!drag || !drop || drop.contains(drag)) {
    return;
  }
  const previousDrop = drag.classList.contains("seb-moodle-placed-drag")
    ? getClosestMoodleDropTarget(drag.parentElement)
    : null;
  const choice = getMoodleChoiceFromDrag(drag);
  const placedCard = drag.classList.contains("seb-moodle-source-drag")
    ? createMoodleDragCard(frameDocument, choice, true)
    : drag;

  clearMoodleDropAnswer(frameDocument, drop);
  drop.append(placedCard);
  if (previousDrop && previousDrop !== drop) {
    clearMoodleDropAnswer(frameDocument, previousDrop);
  }
  drop.classList.add("moodle-drop-filled");
  updateMoodleDropAnswer(frameDocument, drop, placedCard);
}

function clearMoodleDropAnswer(frameDocument, drop) {
  drop.querySelectorAll(".seb-moodle-placed-drag").forEach((card) => card.remove());
  drop.classList.remove("moodle-drop-filled", "moodle-drop-active");
  delete drop.dataset.sebDropValue;
  delete drop.dataset.sebDropText;
  delete drop.dataset.sebFieldName;

  for (const field of findMoodleDropFields(frameDocument, drop)) {
    const type = (field.getAttribute("type") || field.tagName).toLowerCase();
    if (type === "checkbox" || type === "radio") {
      field.checked = false;
    } else {
      field.value = field.classList.contains("placeinput") || type === "hidden" ? "0" : "";
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function updateMoodleDropAnswer(frameDocument, drop, drag) {
  const value = getMoodleDragValue(drag);
  drop.dataset.sebDropValue = value;
  drop.dataset.sebDropText = drag.textContent.trim();

  const fields = findMoodleDropFields(frameDocument, drop);
  for (const field of fields) {
    const type = (field.getAttribute("type") || field.tagName).toLowerCase();
    if (type === "checkbox" || type === "radio") {
      field.checked = field.value === value || field.value === drag.textContent.trim();
    } else {
      field.value = value;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (!fields.length) {
    drop.dataset.sebFieldName = getMoodleDropFieldName(drop);
  }
}

function getMoodleDragValue(drag) {
  const choice = getMoodleElementClassNumber(drag, "choice");
  if (choice) {
    return choice;
  }
  const attrNames = ["data-value", "data-id", "data-choice", "data-dragid", "data-drag", "data-no", "value"];
  for (const attrName of attrNames) {
    const value = drag.getAttribute(attrName);
    if (value) {
      return value;
    }
  }
  const idMatch = (drag.id || "").match(/(?:choice|drag|item|answer)?[-_:]?(\d+)$/i);
  if (idMatch) {
    return idMatch[1];
  }
  return drag.textContent.trim();
}

function getMoodleChoiceFromDrag(drag) {
  return {
    value: getMoodleDragValue(drag),
    group: getMoodleDragGroup(drag),
    text: drag.dataset.text || normalizeMoodleChoiceText(drag.textContent),
    html: drag.innerHTML.trim() || escapeHtml(drag.dataset.text || drag.textContent.trim())
  };
}

function getMoodleDragGroup(drag) {
  return drag.dataset.group
    || drag.getAttribute("data-group")
    || getMoodleElementClassNumber(drag, "group")
    || "1";
}

function getMoodleDropGroup(drop) {
  return drop.dataset.group
    || drop.getAttribute("data-group")
    || getMoodleElementClassNumber(drop, "group")
    || "";
}

function getMoodleDropPlace(drop) {
  return drop.dataset.place
    || drop.getAttribute("data-place")
    || getMoodleElementClassNumber(drop, "place")
    || (drop.id.match(/(?:^|_p)(\d+)$/)?.[1] || "");
}

function getMoodleElementClassNumber(element, prefix) {
  for (const className of Array.from(element.classList || [])) {
    const match = className.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
    if (match) {
      return match[1];
    }
  }
  return "";
}

function findMoodleDropFields(frameDocument, drop) {
  const fields = Array.from(drop.querySelectorAll("input[name], select[name], textarea[name]"));
  const selectors = [];
  const directNames = [
    drop.dataset.inputName,
    drop.dataset.fieldName,
    drop.dataset.name,
    drop.getAttribute("data-inputname"),
    drop.getAttribute("data-fieldname"),
    drop.getAttribute("data-name"),
    drop.id
  ].filter(Boolean);
  for (const name of directNames) {
    selectors.push(`[name="${CSS.escape(name)}"]`, `#${CSS.escape(name)}`);
  }

  const place = getMoodleDropPlace(drop);
  const group = getMoodleDropGroup(drop);
  if (place) {
    const placeClass = `place${place}`;
    const groupClass = group ? `group${group}` : "";
    fields.push(...Array.from(frameDocument.querySelectorAll("input[name], select[name], textarea[name]")).filter((element) => (
      element.classList.contains(placeClass) && (!groupClass || element.classList.contains(groupClass))
    )));
    selectors.push(`[name$="_p${CSS.escape(place)}"]`, `[name$="[${CSS.escape(place)}]"]`);
    selectors.push(`.placeinput.place${CSS.escape(place)}`, `input.place${CSS.escape(place)}[name]`);
    if (group) {
      selectors.push(`.placeinput.place${CSS.escape(place)}.group${CSS.escape(group)}`);
    }
  }

  for (const selector of selectors) {
    try {
      fields.push(...Array.from(frameDocument.querySelectorAll(selector)).filter((element) => (
        element.matches("input[name], select[name], textarea[name]")
      )));
    } catch {
      // Ignore selector forms that cannot be represented in CSS.
    }
  }

  return Array.from(new Set(fields)).filter((field) => !field.disabled);
}

function getMoodleDropFieldName(drop) {
  return drop.dataset.inputName
    || drop.dataset.fieldName
    || drop.dataset.name
    || drop.id
    || (drop.dataset.place ? `drop-${drop.dataset.place}` : "");
}

function collectMoodleFrameAnswerFields() {
  const fields = [];
  const elements = getMoodleFrameAnswerElements();
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || tagName).toLowerCase();
    if (type === "radio") {
      if (!element.checked) {
        continue;
      }
      fields.push(createAnswerField(element, type, element.value, true));
      continue;
    }
    if (type === "checkbox") {
      fields.push(createAnswerField(element, type, element.value, element.checked));
      continue;
    }
    fields.push(createAnswerField(element, type, element.value, null));
  }

  fields.push(...collectMoodleFrameDropAnswerFields(fields));
  return fields;
}

function collectMoodleFrameDropAnswerFields(existingFields) {
  const frameDocument = els.moodleQuestionFrame.contentDocument;
  if (!frameDocument) {
    return [];
  }
  const existingKeys = new Set(existingFields.flatMap((field) => [
    field.name,
    field.id,
    field.selector
  ]).filter(Boolean));
  return Array.from(frameDocument.querySelectorAll("[data-seb-drop-value]"))
    .filter((drop) => !findMoodleDropFields(frameDocument, drop).length)
    .map((drop) => {
      const name = getMoodleDropFieldName(drop);
      const selector = drop.id ? `#${CSS.escape(drop.id)}` : "";
      return {
        name,
        id: drop.id || "",
        selector,
        type: "dragdrop",
        value: drop.dataset.sebDropValue || "",
        text: drop.dataset.sebDropText || "",
        checked: null
      };
    })
    .filter((field) => (
      field.value
      && !existingKeys.has(field.name)
      && !existingKeys.has(field.id)
      && !existingKeys.has(field.selector)
    ));
}

function collectMoodleEditorAnswerFields() {
  const fields = [];
  const elements = Array.from(els.moodleAnswerFields.querySelectorAll("input[name], select[name], textarea[name]"));
  for (const element of elements) {
    const type = (element.dataset.type || element.getAttribute("type") || element.tagName).toLowerCase();
    if (isMoodleHousekeepingField(element.name, type)) {
      continue;
    }
    if (type === "radio") {
      if (!element.checked) {
        continue;
      }
      fields.push(createEditorAnswerField(element, "radio", element.value, true));
      continue;
    }
    if (type === "checkbox") {
      fields.push(createEditorAnswerField(element, "checkbox", element.value, element.checked));
      continue;
    }
    fields.push(createEditorAnswerField(element, type, element.value, null));
  }
  return fields;
}

function createEditorAnswerField(element, type, value, checked) {
  return {
    controlId: element.dataset.controlId || "",
    name: element.name || "",
    id: element.dataset.id || element.id || "",
    selector: element.dataset.selector || "",
    type,
    value: value || "",
    checked
  };
}

function createAnswerField(element, type, value, checked) {
  return {
    name: element.getAttribute("name") || "",
    id: element.id || "",
    selector: element.id ? `#${CSS.escape(element.id)}` : "",
    type,
    value: value || "",
    checked
  };
}

function getMoodleDraftFields(draft) {
  return Array.isArray(draft) ? draft : Array.isArray(draft?.fields) ? draft.fields : [];
}

function getMoodleDraftKey(fields) {
  return JSON.stringify(getMoodleDraftFields(fields).map((field) => ({
    controlId: field.controlId || "",
    name: field.name || "",
    id: field.id || "",
    selector: field.selector || "",
    type: field.type || "",
    value: field.value || "",
    values: Array.isArray(field.values) ? field.values : [],
    text: field.text || "",
    checked: typeof field.checked === "boolean" ? field.checked : null
  })));
}

function attachMoodleFrameDraftListeners(frameDocument) {
  if (!frameDocument || !frameDocument.body || frameDocument.body.dataset.sebMoodleDraftListenersReady === "true") {
    return;
  }
  frameDocument.body.dataset.sebMoodleDraftListenersReady = "true";
  frameDocument.addEventListener("input", scheduleMoodleDraftUpdate, true);
  frameDocument.addEventListener("change", scheduleMoodleDraftUpdate, true);
}

function scheduleMoodleDraftUpdate() {
  if (state.applyingMoodleDraft || !state.selectedSessionId || !state.selectedMoodleQuestionId) {
    return;
  }
  window.clearTimeout(state.moodleDraftTimer);
  state.moodleDraftTimer = window.setTimeout(sendMoodleDraftUpdate, 180);
}

function sendMoodleDraftUpdate() {
  if (
    state.applyingMoodleDraft
    || !state.socket
    || state.socket.readyState !== WebSocket.OPEN
    || !state.selectedSessionId
    || !state.selectedMoodleQuestionId
  ) {
    return;
  }

  const fields = collectMoodleAnswerFields();
  if (!fields.length) {
    return;
  }
  const draftKey = getMoodleDraftKey(fields);
  if (draftKey === state.lastSentMoodleDraftKey) {
    return;
  }
  state.lastSentMoodleDraftKey = draftKey;
  state.socket.send(JSON.stringify({
    type: "moodle.answer.draft.update",
    sessionId: state.selectedSessionId,
    questionId: state.selectedMoodleQuestionId,
    clientDraftId: crypto.randomUUID(),
    operatorClientId: state.operatorClientId,
    operatorDisplayName: state.displayName || "Operator",
    fields
  }));
}

function applyMoodleDraft(draft, options = {}) {
  const fields = getMoodleDraftFields(draft);
  if (!fields.length) {
    return;
  }

  state.applyingMoodleDraft = true;
  try {
    const frameDocument = els.moodleQuestionFrame.contentDocument;
    if (frameDocument) {
      applyMoodleDraftFieldsToFrame(frameDocument, fields, options);
    }
    applyMoodleDraftFieldsToEditor(fields, options);
    state.lastSentMoodleDraftKey = getMoodleDraftKey(collectMoodleAnswerFields());
  } finally {
    state.applyingMoodleDraft = false;
  }
}

function applyMoodleDraftToEditorOnly(draft) {
  const fields = getMoodleDraftFields(draft);
  if (!fields.length) {
    return;
  }
  state.applyingMoodleDraft = true;
  try {
    applyMoodleDraftFieldsToEditor(fields);
  } finally {
    state.applyingMoodleDraft = false;
  }
}

function applyMoodleDraftFieldsToEditor(fields, options = {}) {
  for (const field of fields) {
    for (const element of findMoodleFieldElements(els.moodleAnswerFields, field)) {
      setMoodleFormElementValue(element, field, options);
    }
  }
}

function applyMoodleDraftFieldsToFrame(frameDocument, fields, options = {}) {
  for (const field of fields) {
    const elements = findMoodleFieldElements(frameDocument, field);
    for (const element of elements) {
      setMoodleFormElementValue(element, field, options);
    }

    const drop = findMoodleDropForDraftField(frameDocument, field, elements[0] || null);
    if (drop) {
      applyMoodleDropDraftValue(frameDocument, drop, field);
    }
  }
}

function findMoodleFieldElements(root, field) {
  if (!root || !field) {
    return [];
  }
  const selectors = [];
  if (field.selector) {
    selectors.push(field.selector);
  }
  if (field.id) {
    selectors.push(`#${CSS.escape(field.id)}`);
  }
  if (field.name) {
    selectors.push(`[name="${CSS.escape(field.name)}"]`);
  }
  if (field.controlId) {
    selectors.push(`[data-control-id="${CSS.escape(field.controlId)}"]`);
  }

  const elements = [];
  for (const selector of selectors) {
    try {
      elements.push(...Array.from(root.querySelectorAll(selector)).filter((element) => (
        element.matches("input[name], select[name], textarea[name]")
      )));
    } catch {
      // Some client-provided selectors may contain Moodle ids that need escaping.
    }
  }
  return Array.from(new Set(elements)).filter((element) => !element.disabled);
}

function isMoodleActiveElement(element) {
  return Boolean(element?.ownerDocument && element.ownerDocument.activeElement === element);
}

function setMoodleFormElementValue(element, field, options = {}) {
  if (options.preserveActiveElement && isMoodleActiveElement(element)) {
    return;
  }

  const tagName = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || tagName).toLowerCase();
  const value = field.value || "";
  const values = Array.isArray(field.values) ? field.values : [];

  if (type === "radio") {
    element.checked = element.value === value || (field.checked === true && (!value || element.value === value));
    return;
  }
  if (type === "checkbox") {
    if (values.length) {
      element.checked = values.includes(element.value);
    } else if (typeof field.checked === "boolean") {
      element.checked = field.checked;
    } else {
      element.checked = element.value === value;
    }
    return;
  }
  if (tagName === "select" && element.multiple) {
    const selectedValues = new Set(values.length ? values : [value]);
    for (const option of element.options) {
      option.selected = selectedValues.has(option.value);
    }
    return;
  }
  element.value = value;
}

function findMoodleDropForDraftField(frameDocument, field, fieldElement) {
  const directTargets = [];
  for (const selector of [field.selector, field.id ? `#${CSS.escape(field.id)}` : ""].filter(Boolean)) {
    try {
      directTargets.push(...Array.from(frameDocument.querySelectorAll(selector)).filter(isMoodleDropTarget));
    } catch {
      // Keep looking with structural hints below.
    }
  }
  if (directTargets.length) {
    return directTargets[0];
  }

  const place = fieldElement ? getMoodleElementClassNumber(fieldElement, "place") : getMoodlePlaceFromFieldName(field.name);
  const group = fieldElement ? getMoodleElementClassNumber(fieldElement, "group") : "";
  if (!place) {
    return null;
  }
  return getMoodleDropTargets(frameDocument).find((drop) => (
    getMoodleDropPlace(drop) === place && (!group || getMoodleDropGroup(drop) === group)
  )) || null;
}

function getMoodlePlaceFromFieldName(name) {
  return String(name || "").match(/(?:_p|\[)(\d+)(?:\]|$)/)?.[1] || "";
}

function applyMoodleDropDraftValue(frameDocument, drop, field) {
  const value = String(field.value || "").trim();
  if (!value || value === "0") {
    clearMoodleDropAnswer(frameDocument, drop);
    return;
  }

  const group = getMoodleDropGroup(drop) || "1";
  const choice = findMoodleChoiceForValue(frameDocument, value, group, field.text);
  clearMoodleDropAnswer(frameDocument, drop);
  const placedCard = createMoodleDragCard(frameDocument, choice, true);
  drop.append(placedCard);
  drop.classList.add("moodle-drop-filled");
  updateMoodleDropAnswer(frameDocument, drop, placedCard);
}

function findMoodleChoiceForValue(frameDocument, value, group, fallbackText) {
  const cards = Array.from(frameDocument.querySelectorAll(".seb-moodle-source-drag, .moodle-drag-card"));
  const exact = cards.find((card) => getMoodleDragValue(card) === value && getMoodleDragGroup(card) === group)
    || cards.find((card) => getMoodleDragValue(card) === value);
  if (exact) {
    return getMoodleChoiceFromDrag(exact);
  }
  const text = fallbackText || value;
  return {
    value,
    group,
    text,
    html: escapeHtml(text)
  };
}

function resetMessages() {
  state.renderedMessageKeys = new Set();
  els.messages.innerHTML = "";
}

function getMessageKeys(message) {
  const keys = [];
  if (message.messageId) {
    keys.push(`message:${message.messageId}`);
  }
  if (message.clientMessageId) {
    keys.push(`client:${message.clientMessageId}`);
  }
  if (!keys.length) {
    keys.push(`fallback:${message.sender || ""}:${message.createdAt || ""}:${message.text || ""}`);
  }
  return keys;
}

function appendMessage(message) {
  const keys = getMessageKeys(message);
  if (keys.some((key) => state.renderedMessageKeys.has(key))) {
    for (const key of keys) {
      state.renderedMessageKeys.add(key);
    }
    return;
  }
  for (const key of keys) {
    state.renderedMessageKeys.add(key);
  }

  const row = document.createElement("div");
  row.className = `message ${message.sender === "operator" ? "operator" : message.sender === "system" ? "system" : "extension"}`;
  const sender = message.sender === "operator"
    ? message.operatorDisplayName || message.operatorId || "operator"
    : message.sender === "system"
      ? "system"
      : "extension";
  const meta = document.createElement("strong");
  meta.textContent = `${sender} - ${formatTime(message.createdAt)}`;
  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = message.text || "";
  row.append(meta, body);
  els.messages.append(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function formatSessionTitle(session) {
  const displayId = session.displayId ? `#${formatSessionDisplayId(session.displayId)}` : session.sessionId;
  const label = session.domain || session.userLabel || session.sessionId;
  return `${displayId} ${label}`;
}

function formatSessionCardTitle(session) {
  const displayId = session.displayId ? `#${formatSessionDisplayId(session.displayId)}` : session.sessionId;
  return displayId;
}

function formatSessionDisplayId(displayId) {
  const value = String(displayId || "").trim();
  if (!/^\d+$/.test(value)) {
    return value;
  }
  return String(Number.parseInt(value, 10));
}

function formatSessionScreenshot(session) {
  return `screenshot ${formatTime(session.lastScreenshotAt)}`;
}

function showError(error) {
  els.connectionStatus.textContent = error.message;
}

function connectSocket() {
  if (state.socket) {
    state.socket.close();
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${location.host}/v1/operator/ws`);

  state.socket = new WebSocket(url);
  state.socket.addEventListener("open", () => {
    els.connectionStatus.textContent = "online";
  });
  state.socket.addEventListener("close", () => {
    els.connectionStatus.textContent = "offline";
  });
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "session.upsert") {
      if (message.session.status === "active") {
        state.sessions.set(message.session.sessionId, message.session);
      } else {
        state.sessions.delete(message.session.sessionId);
        if (state.selectedSessionId === message.session.sessionId) {
          state.selectedSessionId = "";
          resetMessages();
        }
      }
      renderSessions();
    }
    if (message.type === "session.screenshot_updated") {
      const session = state.sessions.get(message.sessionId);
      if (session) {
        session.lastScreenshotAt = message.capturedAt;
        session.lastScreenshotUrl = message.url;
        renderSessions();
      }
    }
    if (message.type === "session.sos" || message.type === "session.sos.cleared") {
      const session = state.sessions.get(message.sessionId);
      if (session) {
        session.sos = message.sos || null;
        session.sosActive = Boolean(message.sos?.active);
        renderSessions();
        renderDetail();
      }
    }
    if (message.type === "chat.message" && message.sessionId === state.selectedSessionId) {
      appendMessage(message);
    }
    if (message.type === "moodle.question.upsert" && message.sessionId === state.selectedSessionId) {
      state.moodleQuestions = new Map([[message.question.questionId, message.question]]);
      state.selectedMoodleQuestionId = message.question.questionId;
      renderMoodleQuestion();
    }
    if (message.type === "moodle.answer.submitted" && message.sessionId === state.selectedSessionId) {
      els.moodleAnswerStatus.textContent = `answer ${message.deliveryStatus}`;
    }
    if (message.type === "moodle.answer.draft.updated" && message.sessionId === state.selectedSessionId) {
      const question = state.moodleQuestions.get(message.questionId);
      if (question) {
        question.latestDraft = message;
      }
      if (message.questionId === state.selectedMoodleQuestionId && message.operatorClientId !== state.operatorClientId) {
        applyMoodleDraft(message, { preserveActiveElement: true });
      }
    }
    if (message.type === "moodle.answer.result" && message.sessionId === state.selectedSessionId) {
      els.moodleAnswerStatus.textContent = message.status === "error"
        ? message.error?.message || "answer error"
        : "answer applied";
      loadMoodleQuestions().catch(showError);
    }
  });
}

for (const tabButton of [els.liveTab, els.moodleTab]) {
  tabButton.addEventListener("click", () => {
    state.activeSessionTab = tabButton.dataset.sessionTab || "live";
    renderSessionTabs();
  });
}

els.moodleQuestionFrame.addEventListener("load", () => {
  prepareMoodleQuestionFrame();
});

els.moodleAnswerFields.addEventListener("input", scheduleMoodleDraftUpdate);
els.moodleAnswerFields.addEventListener("change", scheduleMoodleDraftUpdate);

els.displayNameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  els.displayName.blur();
});

els.displayName.addEventListener("input", () => {
  updateDisplayName(els.displayName.value, { rememberPrompt: true });
});

els.displayNamePromptDialog.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = els.displayNamePromptInput.value.trim();
  if (!value) {
    hideDisplayNamePrompt();
    return;
  }
  updateDisplayName(value, { syncInputs: true, rememberPrompt: true });
});

els.displayNamePromptClose.addEventListener("click", () => {
  hideDisplayNamePrompt();
});

els.displayNamePrompt.addEventListener("click", (event) => {
  if (event.target === els.displayNamePrompt) {
    hideDisplayNamePrompt();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.displayNamePrompt.hidden) {
    hideDisplayNamePrompt();
  }
});

async function sendCommand(name) {
  if (!state.selectedSessionId) {
    return;
  }
  await api(`/v1/operator/sessions/${state.selectedSessionId}/commands`, {
    method: "POST",
    body: JSON.stringify({ name, payload: {} })
  });
}

els.captureNow.addEventListener("click", () => sendCommand("screenshot.capture_now").catch(showError));

els.clearSos.addEventListener("click", async () => {
  if (!state.selectedSessionId) {
    return;
  }
  try {
    const payload = await api(`/v1/operator/sessions/${state.selectedSessionId}/sos/clear`, {
      method: "POST",
      body: JSON.stringify({
        operatorDisplayName: state.displayName || "Operator"
      })
    });
    if (payload.session) {
      state.sessions.set(payload.session.sessionId, payload.session);
      renderSessions();
      renderDetail();
    }
  } catch (error) {
    showError(error);
  }
});

els.sendMoodleAnswers.addEventListener("click", async () => {
  if (!state.selectedSessionId || !state.selectedMoodleQuestionId) {
    return;
  }
  const fields = collectMoodleAnswerFields();
  if (!fields.length) {
    els.moodleAnswerStatus.textContent = "no answer fields";
    return;
  }
  const payload = await api(`/v1/operator/sessions/${state.selectedSessionId}/moodle/questions/${state.selectedMoodleQuestionId}/answers`, {
    method: "POST",
    body: JSON.stringify({
      fields,
      operatorDisplayName: state.displayName || "Operator"
    })
  });
  els.moodleAnswerStatus.textContent = `answer ${payload.deliveryStatus}`;
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedSessionId) {
    return;
  }
  const text = els.messageText.value.trim();
  if (!text) {
    return;
  }
  const selectedSessionId = state.selectedSessionId;
  const clientMessageId = crypto.randomUUID();
  const operatorDisplayName = state.displayName || "Operator";
  appendMessage({
    clientMessageId,
    sessionId: selectedSessionId,
    sender: "operator",
    operatorDisplayName,
    text,
    createdAt: new Date().toISOString(),
    deliveryStatus: "sending"
  });
  els.messageText.value = "";

  try {
    const payload = await api(`/v1/operator/sessions/${selectedSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        clientMessageId,
        text,
        operatorDisplayName
      })
    });
    appendMessage({
      ...payload,
      clientMessageId,
      sessionId: selectedSessionId,
      sender: "operator",
      operatorDisplayName,
      text
    });
  } catch (error) {
    showError(error);
  }
});

els.messageText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.messageForm.requestSubmit();
  }
});

connectSocket();
showDisplayNamePrompt();
loadSessions().then(() => Promise.all([
  loadMessages(),
  loadMoodleQuestions()
])).catch(showError);
setInterval(() => {
  loadSessions().then(() => Promise.all([
    loadMessages(),
    loadMoodleQuestions()
  ])).catch(showError);
}, 15000);

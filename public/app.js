const state = {
  displayName: localStorage.getItem("seb.displayName") || "",
  sessions: new Map(),
  moodleQuestions: new Map(),
  selectedSessionId: "",
  selectedMoodleQuestionId: "",
  activeSessionTab: "live",
  renderedMessageKeys: new Set(),
  socket: null,
  screenshotObjectUrl: ""
};

const els = {
  connectionStatus: document.getElementById("connectionStatus"),
  displayNameForm: document.getElementById("displayNameForm"),
  displayName: document.getElementById("displayName"),
  refreshSessions: document.getElementById("refreshSessions"),
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
    item.className = `session-item ${session.sessionId === state.selectedSessionId ? "active" : ""}`;
    item.dataset.sessionId = session.sessionId;
    item.innerHTML = `
      <span class="session-line">
        <span class="session-domain">${escapeHtml(formatSessionTitle(session))}</span>
        <span class="badge ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>
      </span>
      <span class="session-url">${escapeHtml(session.currentUrl || "no url")}</span>
      <span class="session-time">seen ${escapeHtml(formatTime(session.lastSeenAt))} - screenshot ${escapeHtml(formatTime(session.lastScreenshotAt))}</span>
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
    state.moodleQuestions = new Map();
    state.selectedMoodleQuestionId = "";
    renderMoodleQuestion();
    return;
  }

  els.detailTitle.textContent = formatSessionTitle(session);
  els.detailMeta.textContent = `${session.status} - started ${formatTime(session.startedAt)} - ${session.currentUrl || "no url"}`;

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

function renderMoodleQuestion() {
  const session = state.sessions.get(state.selectedSessionId);
  const questions = Array.from(state.moodleQuestions.values())
    .sort((left, right) => Date.parse(right.updatedAt || right.receivedAt || 0) - Date.parse(left.updatedAt || left.receivedAt || 0));
  const question = state.moodleQuestions.get(state.selectedMoodleQuestionId) || questions[0] || null;
  if (question && state.selectedMoodleQuestionId !== question.questionId) {
    state.selectedMoodleQuestionId = question.questionId;
  }

  els.moodleQuestionEmpty.hidden = Boolean(question);
  els.moodleQuestionPane.hidden = !question;
  els.sendMoodleAnswers.disabled = !question;
  if (!session || !question) {
    els.moodleMeta.textContent = "No question yet";
    els.moodleAnswerStatus.textContent = "";
    els.moodleQuestionFrame.removeAttribute("srcdoc");
    els.moodleAnswerFields.innerHTML = "";
    els.moodleAnswerFields.hidden = false;
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
  els.moodleQuestionFrame.srcdoc = buildMoodleQuestionDocument(question);
  renderMoodleAnswerFields(question);
  syncMoodleAnswerFallback();
}

function getMoodleQuestionBodyHtml(question) {
  if (question.html) {
    try {
      const parsed = new DOMParser().parseFromString(question.html, "text/html");
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
      .drop,
      .dropzone,
      .place {
        border-style: dashed;
        background: #f1f3f5;
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

function syncMoodleAnswerFallback() {
  els.moodleAnswerFields.hidden = getMoodleFrameAnswerElements().length > 0;
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

  return fields;
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
  row.className = `message ${message.sender === "operator" ? "operator" : "extension"}`;
  const sender = message.sender === "operator"
    ? message.operatorDisplayName || message.operatorId || "operator"
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
  const displayId = session.displayId ? `#${session.displayId}` : session.sessionId;
  const label = session.domain || session.userLabel || session.sessionId;
  return `${displayId} ${label}`;
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
    if (message.type === "moodle.answer.result" && message.sessionId === state.selectedSessionId) {
      els.moodleAnswerStatus.textContent = message.status === "error"
        ? message.error?.message || "answer error"
        : "answer applied";
      loadMoodleQuestions().catch(showError);
    }
  });
}

els.refreshSessions.addEventListener("click", () => {
  loadSessions().then(() => Promise.all([
    loadMessages(),
    loadMoodleQuestions()
  ])).catch(showError);
});

for (const tabButton of [els.liveTab, els.moodleTab]) {
  tabButton.addEventListener("click", () => {
    state.activeSessionTab = tabButton.dataset.sessionTab || "live";
    renderSessionTabs();
  });
}

els.moodleQuestionFrame.addEventListener("load", () => {
  syncMoodleAnswerFallback();
});

els.displayNameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  els.displayName.blur();
});

els.displayName.addEventListener("input", () => {
  state.displayName = els.displayName.value.trim();
  localStorage.setItem("seb.displayName", state.displayName);
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

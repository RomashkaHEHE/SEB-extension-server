const state = {
  displayName: localStorage.getItem("seb.displayName") || "",
  sessions: new Map(),
  moodleQuestions: new Map(),
  selectedSessionId: "",
  selectedMoodleQuestionId: "",
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
  screenshot: document.getElementById("screenshot"),
  screenshotEmpty: document.getElementById("screenshotEmpty"),
  captureNow: document.getElementById("captureNow"),
  refreshMoodleQuestions: document.getElementById("refreshMoodleQuestions"),
  moodleMeta: document.getElementById("moodleMeta"),
  moodleQuestionEmpty: document.getElementById("moodleQuestionEmpty"),
  moodleQuestionPane: document.getElementById("moodleQuestionPane"),
  moodleQuestionSelect: document.getElementById("moodleQuestionSelect"),
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

  if (!state.selectedSessionId || !state.sessions.has(state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.sessionId || "";
  }
  renderDetail();
}

function renderDetail() {
  const session = state.sessions.get(state.selectedSessionId);
  els.emptyState.hidden = Boolean(session);
  els.sessionDetail.hidden = !session;
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
  els.messages.innerHTML = "";
  for (const message of payload.messages) {
    appendMessage(message);
  }
}

async function loadMoodleQuestions() {
  if (!state.selectedSessionId) {
    return;
  }
  const payload = await api(`/v1/operator/sessions/${state.selectedSessionId}/moodle/questions`);
  state.moodleQuestions = new Map(payload.questions.map((question) => [question.questionId, question]));
  if (!state.selectedMoodleQuestionId || !state.moodleQuestions.has(state.selectedMoodleQuestionId)) {
    state.selectedMoodleQuestionId = payload.questions[0]?.questionId || "";
  }
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

  els.moodleQuestionSelect.innerHTML = "";
  for (const item of questions) {
    const option = document.createElement("option");
    option.value = item.questionId;
    option.textContent = formatMoodleQuestionTitle(item);
    option.selected = item.questionId === state.selectedMoodleQuestionId;
    els.moodleQuestionSelect.append(option);
  }

  els.moodleQuestionEmpty.hidden = Boolean(question);
  els.moodleQuestionPane.hidden = !question;
  els.sendMoodleAnswers.disabled = !question;
  if (!session || !question) {
    els.moodleMeta.textContent = "No question yet";
    els.moodleAnswerStatus.textContent = "";
    els.moodleQuestionFrame.removeAttribute("srcdoc");
    els.moodleAnswerFields.innerHTML = "";
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
}

function buildMoodleQuestionDocument(question) {
  const baseHref = question.baseUrl || question.pageUrl || "";
  const body = question.html || `<pre>${escapeHtml(question.text || "")}</pre>`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base href="${escapeAttribute(baseHref)}">
    <style>
      body { margin: 12px; color: #17201d; font: 14px/1.45 Arial, sans-serif; }
      img, video { max-width: 100%; height: auto; }
      audio { width: 100%; max-width: 420px; }
      table { max-width: 100%; border-collapse: collapse; }
      input, select, textarea, button { font: inherit; }
      .que { max-width: 100%; }
      .info { color: #65706a; font-size: 12px; margin-bottom: 8px; }
      .answer div, .r0, .r1 { margin: 6px 0; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function formatMoodleQuestionTitle(question) {
  const number = question.questionNumber ? `#${question.questionNumber}` : "question";
  const type = question.questionType || "moodle";
  return `${number} ${type} - ${formatTime(question.updatedAt || question.receivedAt)}`;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function renderMoodleAnswerFields(question) {
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
  const editorFields = collectMoodleEditorAnswerFields();
  if (editorFields.length) {
    return editorFields;
  }

  const frameDocument = els.moodleQuestionFrame.contentDocument;
  if (!frameDocument) {
    return [];
  }

  const fields = [];
  const elements = Array.from(frameDocument.querySelectorAll("input[name], select[name], textarea[name]"));
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || tagName).toLowerCase();
    const name = element.getAttribute("name") || "";
    if (element.disabled || isMoodleHousekeepingField(name, type)) {
      continue;
    }
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

function appendMessage(message) {
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
          els.messages.innerHTML = "";
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
      state.moodleQuestions.set(message.question.questionId, message.question);
      if (!state.selectedMoodleQuestionId) {
        state.selectedMoodleQuestionId = message.question.questionId;
      }
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

els.refreshMoodleQuestions.addEventListener("click", () => {
  loadMoodleQuestions().catch(showError);
});

els.moodleQuestionSelect.addEventListener("change", () => {
  state.selectedMoodleQuestionId = els.moodleQuestionSelect.value;
  renderMoodleQuestion();
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
  await api(`/v1/operator/sessions/${state.selectedSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      clientMessageId: crypto.randomUUID(),
      text,
      operatorDisplayName: state.displayName || "Operator"
    })
  });
  els.messageText.value = "";
});

els.messageText.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
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
  loadSessions().then(loadMessages).catch(showError);
}, 15000);

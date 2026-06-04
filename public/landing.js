const CHROME_EXTENSIONS_URL = "chrome://extensions";

const extensionButton = document.getElementById("downloadExtension");
const startScreen = document.getElementById("startScreen");

function copyWithTextarea(value) {
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.className = "clipboard-buffer";
  document.body.append(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_error) {
    copied = false;
  }

  field.remove();
  return copied;
}

function copyChromeExtensionsUrl() {
  copyWithTextarea(CHROME_EXTENSIONS_URL);

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(CHROME_EXTENSIONS_URL).catch(() => {});
  }
}

function showStartScreen() {
  document.body.classList.add("landing-started");
  startScreen.hidden = false;
}

function downloadExtensionArchive() {
  const downloadLink = document.createElement("a");
  downloadLink.href = extensionButton.href;
  downloadLink.download = "";
  downloadLink.rel = "noopener";
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
}

extensionButton.addEventListener("click", (event) => {
  event.preventDefault();
  copyChromeExtensionsUrl();
  showStartScreen();
  downloadExtensionArchive();
});

const form = document.getElementById("auto-form");
const letterInput = document.getElementById("cover-letter");
const countInput = document.getElementById("responses-count");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");

const DEFAULT_COUNT = 200;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  if (kind) {
    statusEl.dataset.kind = kind;
  } else {
    statusEl.removeAttribute("data-kind");
  }
}

function getActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    callback(tabs[0]);
  });
}

function sendToActive(message, onDone) {
  getActiveTab((tab) => {
    if (!tab?.id) {
      setStatus("Не удалось найти активную вкладку.", "error");
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(
          "Откройте страницу выдачи вакансий на hh.ru (результаты поиска) и обновите её.",
          "error"
        );
        return;
      }
      if (typeof onDone === "function") onDone(response);
    });
  });
}

function renderState(state) {
  if (!state) return;
  if (state.active) {
    setStatus(
      `Работает: ${state.sentCount}/${state.targetCount} (статус: ${state.status})`,
      "success"
    );
    startBtn.disabled = true;
    countInput.disabled = true;
    letterInput.disabled = true;
  } else {
    setStatus(
      `Остановлено: ${state.sentCount}/${state.targetCount} (статус: ${state.status})`
    );
    startBtn.disabled = false;
    countInput.disabled = false;
    letterInput.disabled = false;
  }
}

function refreshState() {
  sendToActive({ type: "HH_GET_STATE" }, (res) => {
    if (res?.state) renderState(res.state);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const coverLetter = letterInput.value.trim();
  const targetCount = Math.max(
    1,
    parseInt(countInput.value, 10) || DEFAULT_COUNT
  );

  chrome.storage.local.set({ coverLetter, targetCount });
  setStatus("Запускаем автоклик...", "success");

  sendToActive(
    {
      type: "HH_START",
      payload: { coverLetter, targetCount }
    },
    (res) => {
      if (res?.ok) {
        renderState(res.state);
      } else {
        setStatus("Не удалось запустить автоклик.", "error");
      }
    }
  );
});

stopBtn.addEventListener("click", () => {
  sendToActive({ type: "HH_STOP" }, (res) => {
    if (res?.ok) {
      renderState(res.state);
    } else {
      setStatus("Не удалось остановить процесс.", "error");
    }
  });
});

chrome.storage.local.get(["coverLetter", "targetCount"]).then((data) => {
  letterInput.value = data.coverLetter || "";
  countInput.value = data.targetCount || DEFAULT_COUNT;
  refreshState();
});

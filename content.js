(() => {
  const STATE_KEY = "hhAutoResponseState";
  const DEFAULT_STATE = {
    active: false,
    targetCount: 200,
    sentCount: 0,
    coverLetter: "",
    status: "idle",
    startedAt: null,
    lastFinishedAt: null,
    lastListUrl: null
  };

  const TIMING = {
    shortAction: 250,
    coverLetter: 350,
    modalPause: 500,
    beforeSubmit: 500,
    betweenMin: 2000,
    betweenMax: 3000,
    jitterMin: 200,
    jitterMax: 700
  };

  const SELECTORS = {
    vacancyCard: '[data-qa="vacancy-serp__vacancy"]',
    applyButtonByDataQa: 'button[data-qa="vacancy-serp__vacancy_response"], a[data-qa="vacancy-serp__vacancy_response"]',
    modalContainer: '[data-qa="bottom-sheet-content"], form#RESPONSE_MODAL_FORM_ID',
    addCoverLetterText: "Добавить сопроводительное",
    coverLetterInput: 'textarea[data-qa="vacancy-response-popup-form-letter-input"]',
    submitButton:
      'button[data-qa="vacancy-response-submit-popup"], button[form="RESPONSE_MODAL_FORM_ID"], form#RESPONSE_MODAL_FORM_ID button[type="submit"]',
    pagerLink: 'a[data-qa="pager-page"]'
  };

  let state = loadState();
  let isRunning = false;

  function log(...args) {
    console.info("[HH Auto Response]", ...args);
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch (e) {
      log("Не удалось прочитать состояние, сбрасываем", e);
      return { ...DEFAULT_STATE };
    }
  }

  function persist() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      log("Не удалось сохранить состояние", e);
    }
  }

  function updateState(patch) {
    state = { ...state, ...patch };
    persist();
  }

  function sanitizeTargetCount(value) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
    return DEFAULT_STATE.targetCount;
  }

  function startAutomation(options = {}) {
    const coverLetter = (options.coverLetter || "").trim();
    const targetCount = sanitizeTargetCount(options.targetCount);
    updateState({
      active: true,
      targetCount,
      coverLetter,
      sentCount: 0,
      status: "running",
      startedAt: Date.now(),
      lastListUrl: window.location.href
    });
    ensureRunner();
    return { ok: true, state };
  }

  function stopAutomation(reason = "stopped") {
    updateState({
      active: false,
      status: reason,
      lastFinishedAt: Date.now()
    });
    isRunning = false;
    return { ok: true, state };
  }

  function ensureRunner() {
    if (!state.active || isRunning) return;
    runLoop().catch((err) => {
      log("Цикл завершился с ошибкой", err);
      stopAutomation("error");
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function humanDelay() {
    const base = randomInt(TIMING.betweenMin, TIMING.betweenMax);
    const jitter = randomInt(TIMING.jitterMin, TIMING.jitterMax);
    return delay(base + jitter);
  }

  async function waitForModalOrNavigation(initialUrl, timeout = 7000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const modal = document.querySelector(SELECTORS.modalContainer);
        if (modal) {
          clearInterval(interval);
          resolve({ modal, navigated: false });
          return;
        }
        if (
          window.location.pathname.startsWith("/applicant/vacancy_response") ||
          window.location.href !== initialUrl
        ) {
          clearInterval(interval);
          resolve({ modal: null, navigated: true });
          return;
        }
        if (Date.now() - start >= timeout) {
          clearInterval(interval);
          resolve({ modal: null, navigated: false });
        }
      }, 150);
    });
  }

  function waitForSelector(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  function waitForCondition(fn, timeout = 5000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (fn()) return resolve(true);
        if (Date.now() - start >= timeout) return resolve(false);
        setTimeout(check, interval);
      };
      check();
    });
  }

  function isCoverLetterRequired(modal) {
    if (!modal) return false;
    const helper = modal.querySelector('[data-qa="form-helper-description"]');
    const text = (helper?.textContent || "").toLowerCase();
    return text.includes("обязател") || text.includes("обязательное поле");
  }

  function isOnResponsePage() {
    return window.location.pathname.includes("/applicant/vacancy_response");
  }

  async function returnToSearch(initialUrl) {
    log("Пробуем вернуться назад после перехода на страницу отклика");
    window.history.back();
    const backOk = await waitForCondition(() => !isOnResponsePage(), 6000, 200);
    if (backOk) {
      await delay(TIMING.shortAction);
      return;
    }
    if (initialUrl) {
      log("history.back() не вернул, открываем исходную страницу выдачи");
      window.location.href = initialUrl;
      await waitForCondition(() => !isOnResponsePage(), 8000, 200);
      await delay(TIMING.shortAction);
    }
  }

  function findElementByText(root, text) {
    const lower = text.toLowerCase();
    return Array.from(
      root.querySelectorAll("button, [role='button'], a, span, div")
    ).find((el) => (el.textContent || "").toLowerCase().includes(lower));
  }

  function getVacancyCards() {
    return Array.from(document.querySelectorAll(SELECTORS.vacancyCard));
  }

  function findApplyButton(card) {
    const dataQaButton = card.querySelector(SELECTORS.applyButtonByDataQa);
    if (dataQaButton) return dataQaButton;
    const textButton = findElementByText(card, "Откликнуться");
    if (textButton?.closest("button")) return textButton.closest("button");
    if (textButton) return textButton;
    return null;
  }

  async function processCard(card) {
    const applyButton = findApplyButton(card);
    if (!applyButton) return false;

    applyButton.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(TIMING.shortAction);
    const initialUrl = window.location.href;
    updateState({ lastListUrl: initialUrl });
    applyButton.click();

    const { modal, navigated } = await waitForModalOrNavigation(
      initialUrl,
      7000
    );
    if (navigated) {
      log("Кнопка увела на отдельную страницу отклика, возвращаемся назад");
      await returnToSearch(initialUrl);
      return false;
    }

    if (!modal) {
      log("Не нашли модалку после клика, пропускаем карточку");
      return false;
    }
    await delay(TIMING.modalPause);

    if (!state.coverLetter && isCoverLetterRequired(modal)) {
      log("Сопроводительное обязательно, а текст не задан — пропускаем карточку");
      const closeBtn =
        modal.querySelector('[data-qa="response-popup-close"]') ||
        document.querySelector('[data-qa="response-popup-close"]');
      if (closeBtn) {
        closeBtn.click();
        await delay(TIMING.shortAction);
      }
      return false;
    }

    if (state.coverLetter) {
      const addButton = findElementByText(modal, SELECTORS.addCoverLetterText);
      if (addButton) {
        addButton.click();
        await delay(TIMING.shortAction);
      }
      const textarea = modal.querySelector(SELECTORS.coverLetterInput);
      if (textarea) {
        textarea.focus();
        textarea.value = state.coverLetter;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(TIMING.coverLetter);
      }
    }

    await delay(TIMING.beforeSubmit);

    let submitButton = modal.querySelector(SELECTORS.submitButton);
    if (!submitButton) {
      const textButton = findElementByText(modal, "Откликнуться");
      submitButton = textButton?.closest("button") || textButton;
    }
    if (!submitButton) {
      // fallback: ищем в документе, если кнопка вне модалки/формы
      submitButton = document.querySelector(SELECTORS.submitButton);
    }
    if (!submitButton) {
      const textButton = findElementByText(document, "Откликнуться");
      submitButton = textButton?.closest("button") || textButton;
    }
    if (!submitButton) {
      log("Не нашли кнопку отправки отклика");
      return false;
    }

    submitButton.click();

    const closed = await waitForCondition(
      () =>
        !document.contains(modal) ||
        modal.getAttribute("aria-hidden") === "true" ||
        !document.querySelector(SELECTORS.modalContainer),
      7000,
      200
    );

    if (!closed) {
      log("Модалка не закрылась вовремя, продолжаем дальше");
    }
    return true;
  }

  function goToNextPage() {
    const current = document.querySelector(
      `${SELECTORS.pagerLink}[aria-current="true"]`
    );
    const currentItem = current?.closest("li");
    const nextLink = currentItem?.nextElementSibling?.querySelector(
      SELECTORS.pagerLink
    );
    if (nextLink && nextLink.href) {
      log("Переходим на следующую страницу", nextLink.href);
      window.location.href = nextLink.href;
      return true;
    }
    return false;
  }

  async function runLoop() {
    if (isRunning) return;
    isRunning = true;
    log(
      `Запускаем отклики: цель ${state.targetCount}, уже отправлено ${state.sentCount}`
    );

    while (state.active && state.sentCount < state.targetCount) {
      const cards = getVacancyCards();
      let processedOnPage = false;

      for (const card of cards) {
        if (!state.active || state.sentCount >= state.targetCount) break;
        const ok = await processCard(card);
        if (ok) {
          processedOnPage = true;
          updateState({
            sentCount: state.sentCount + 1,
            status: `sent ${state.sentCount + 1}/${state.targetCount}`
          });
          await humanDelay();
        }
      }

      if (!state.active || state.sentCount >= state.targetCount) break;

      if (!processedOnPage) {
        log("Больше нет карточек на странице");
      }

      const moved = goToNextPage();
      if (moved) {
        // После перехода состояние сохранится в sessionStorage, контент-скрипт продолжит на новой странице.
        return;
      }

      // Нет следующей страницы — останавливаемся.
      log("Следующей страницы нет, останавливаем автоматизацию");
      stopAutomation("no-more-pages");
    }

    if (state.sentCount >= state.targetCount) {
      log("Достигнуто нужное число откликов, стоп");
      stopAutomation("target-reached");
    }

    isRunning = false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "HH_START") {
      const res = startAutomation(message.payload || {});
      sendResponse(res);
      return true;
    }

    if (message.type === "HH_STOP") {
      const res = stopAutomation("stopped-by-user");
      sendResponse(res);
      return true;
    }

    if (message.type === "HH_GET_STATE") {
      sendResponse({ ok: true, state });
      return true;
    }
  });

  if (state.active) {
    if (isOnResponsePage()) {
      log("Активное состояние и мы на странице отклика, возвращаемся назад");
      returnToSearch(state.lastListUrl || document.referrer || null);
    }
    log("Найдено активное состояние в sessionStorage, продолжаем работу");
    ensureRunner();
  }
})();

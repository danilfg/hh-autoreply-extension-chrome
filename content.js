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
    lastListUrl: null,
    seenCardKeys: [],
    navigationOnly: []
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
  let seenSet = new Set(state.seenCardKeys || []);
  let navigationOnlySet = new Set(state.navigationOnly || []);
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
    if (patch.seenCardKeys) {
      seenSet = new Set(patch.seenCardKeys);
    }
    if (patch.navigationOnly) {
      navigationOnlySet = new Set(patch.navigationOnly);
    }
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
    seenSet = new Set();
    navigationOnlySet = new Set();
    updateState({
      active: true,
      targetCount,
      coverLetter,
      sentCount: 0,
      status: "running",
      startedAt: Date.now(),
      lastListUrl: window.location.href,
      seenCardKeys: [],
      navigationOnly: []
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

  function waitForElement(root, selector, timeout = 2000, interval = 100) {
    return waitForCondition(
      () => {
        const el = root.querySelector(selector);
        return el || false;
      },
      timeout,
      interval
    ).then((found) => (found === true ? root.querySelector(selector) : found));
  }

  function isCoverLetterRequired(modal) {
    if (!modal) return false;
    const helper = modal.querySelector('[data-qa="form-helper-description"]');
    const text = (helper?.textContent || "").toLowerCase();
    return text.includes("обязател") || text.includes("обязательное поле");
  }

  function isOnResponsePage(url) {
    const href =
      typeof url === "string"
        ? url
        : url?.href || window.location.href || window.location.pathname;
    return href.includes("/applicant/vacancy_response");
  }

  function getCardKey(card) {
    const titleLink =
      card.querySelector('[data-qa="serp-item__title"]') ||
      card.querySelector('a[href*="/vacancy/"]');
    if (titleLink?.href) {
      try {
        const url = new URL(titleLink.href, window.location.origin);
        return url.pathname;
      } catch (_) {
        return titleLink.href;
      }
    }
    const id = card.getAttribute("id");
    if (id) return id;
    return card.textContent?.slice(0, 120) || "";
  }

  function isCardSeen(key) {
    return key ? seenSet.has(key) : false;
  }

  function markCardSeen(key) {
    if (!key) return;
    if (!seenSet.has(key)) {
      seenSet.add(key);
      updateState({ seenCardKeys: Array.from(seenSet) });
    }
  }

  function isNavigationOnly(key) {
    return key ? navigationOnlySet.has(key) : false;
  }

  function markNavigationOnly(key) {
    if (!key) return;
    if (!navigationOnlySet.has(key)) {
      navigationOnlySet.add(key);
      updateState({ navigationOnly: Array.from(navigationOnlySet) });
    }
  }

  async function returnToSearch(initialUrl) {
    if (!isOnResponsePage()) return;

    // Попробуем history.back(), если есть куда вернуться
    const hadReferrer = document.referrer && !isOnResponsePage(document.referrer);
    if (hadReferrer) {
      log("Пробуем вернуться history.back()");
      window.history.back();
      const backOk = await waitForCondition(
        () => !isOnResponsePage(),
        3000,
        150
      );
      if (backOk) {
        updateState({ lastListUrl: window.location.href });
        await delay(TIMING.shortAction);
        return;
      }
    }

    const candidates = [
      state.lastListUrl,
      hadReferrer ? document.referrer : null,
      initialUrl,
      window.location.origin + "/search/vacancy"
    ].filter(Boolean);

    const targetUrl =
      candidates.find((url) => !isOnResponsePage(url)) ||
      window.location.origin + "/search/vacancy";

    updateState({ lastListUrl: targetUrl });
    log("Принудительно возвращаемся с /applicant/vacancy_response на", targetUrl);
    window.location.replace(targetUrl);
    await waitForCondition(() => !isOnResponsePage(), 8000, 200);
    await delay(TIMING.shortAction);
  }

  function findElementByText(root, text) {
    const lower = text.toLowerCase();
    return Array.from(
      root.querySelectorAll("button, [role='button'], a, span, div")
    ).find((el) => (el.textContent || "").toLowerCase().includes(lower));
  }

  function findAddLetterButton(root) {
    return (
      root.querySelector(
        'button[data-qa*="letter"], button[data-qa*="cover"], [role="button"][data-qa*="letter"]'
      ) ||
      findElementByText(root, SELECTORS.addCoverLetterText) ||
      findElementByText(root, "Сопроводительное")
    );
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
    const cardKey = getCardKey(card);
    if (isNavigationOnly(cardKey)) {
      log("Карточка ведёт на страницу отклика, пропускаем", cardKey);
      return false;
    }
    if (isCardSeen(cardKey)) {
      log("Уже обрабатывали карточку, пропускаем", cardKey);
      return false;
    }
    markCardSeen(cardKey);

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
      markNavigationOnly(cardKey);
      await returnToSearch(initialUrl);
      markCardSeen(cardKey);
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
      let textarea = modal.querySelector(SELECTORS.coverLetterInput);
      if (!textarea) {
        const addButton =
          findAddLetterButton(modal) || findAddLetterButton(document);
        if (addButton) {
          addButton.click();
          await delay(TIMING.shortAction + 150);
          textarea =
            modal.querySelector(SELECTORS.coverLetterInput) ||
            (await waitForElement(
              document,
              SELECTORS.coverLetterInput,
              3000,
              100
            ));
        }
      }
      if (!textarea) {
        textarea =
          document.querySelector(SELECTORS.coverLetterInput) ||
          (await waitForElement(
            document,
            SELECTORS.coverLetterInput,
            3000,
            100
          ));
      }
      if (textarea) {
        textarea.focus();
        textarea.value = state.coverLetter;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(TIMING.coverLetter);
      } else {
        log("Не нашли поле сопроводительного, пропускаем карточку");
        const closeBtn =
          modal.querySelector('[data-qa="response-popup-close"]') ||
          document.querySelector('[data-qa="response-popup-close"]');
        if (closeBtn) {
          closeBtn.click();
          await delay(TIMING.shortAction);
        }
        return false;
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

    const navigatedAway = () => isOnResponsePage();

    const closed = await waitForCondition(
      () =>
        navigatedAway() ||
        !document.contains(modal) ||
        modal.getAttribute("aria-hidden") === "true" ||
        !document.querySelector(SELECTORS.modalContainer),
      7000,
      200
    );

    if (navigatedAway()) {
      log("После отправки отклика страница увела на /applicant/vacancy_response, возвращаемся");
      markNavigationOnly(cardKey);
      await returnToSearch(state.lastListUrl || initialUrl);
      markCardSeen(cardKey);
      return false;
    }

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
      updateState({ lastListUrl: nextLink.href });
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
      if (isOnResponsePage()) {
        log("На странице отклика, возвращаемся к выдаче и продолжаем");
        await returnToSearch(state.lastListUrl || window.location.href);
        await delay(TIMING.shortAction);
        continue;
      }

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

      if (isOnResponsePage()) {
        log("На странице отклика, пытаемся вернуться и не останавливаемся");
        await returnToSearch(state.lastListUrl || window.location.href);
        await delay(TIMING.shortAction);
        continue;
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
    if (!isOnResponsePage()) {
      updateState({ lastListUrl: window.location.href });
    } else {
      log("Активное состояние и мы на странице отклика, возвращаемся назад");
      returnToSearch(state.lastListUrl || document.referrer || null);
    }
    log("Найдено активное состояние в sessionStorage, продолжаем работу");
    ensureRunner();
  }
})();

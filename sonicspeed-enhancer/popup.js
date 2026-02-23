/* global browser */

const DEFAULTS = Object.freeze({
  volumeBoost: 1,
  speed: 1,
  nightMode: false,
  pitchSemitones: 0,
});

const LICENSE_ACCEPTED_SANITIZED = "OFFLINEBETA2026";
const PRO_URL = "https://example.com/sonicspeed-pro";
const TRIAL_DURATION_MS = 15 * 60 * 1000;
const VIZ_BOOST_PRO = 1.5;

const PRESETS = Object.freeze({
  movie: { volumeBoost: 1.5, speed: 1, nightMode: true, pitchSemitones: 0 },
  music: { volumeBoost: 1, speed: 1, nightMode: false, pitchSemitones: 0 },
  podcast: { volumeBoost: 1.2, speed: 1.2, nightMode: true, pitchSemitones: 0 },
});

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function formatPercentFromBoost(boost) {
  return `${Math.round(boost * 100)}%`;
}

function formatSpeed(speed) {
  return `${speed.toFixed(1)}×`;
}

// License key: allow only a-zA-Z0-9 to prevent injection. Strip any other characters.
const LICENSE_KEY_SAFE_REGEX = /^[a-zA-Z0-9]+$/;

function sanitizeLicenseKeyInput(raw) {
  const str = String(raw ?? "");
  const alnumOnly = str.replace(/[^a-zA-Z0-9]/g, "");
  return alnumOnly.toUpperCase();
}

function isLicenseKeyValidFormat(sanitized) {
  return LICENSE_KEY_SAFE_REGEX.test(sanitized);
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function getHostnameFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}

async function loadDomainSettings(hostname) {
  const stored = await browser.storage.local.get("domainSettings");
  const all = stored.domainSettings && typeof stored.domainSettings === "object"
    ? stored.domainSettings
    : {};
  const forDomain = all[hostname] && typeof all[hostname] === "object" ? all[hostname] : {};
  return {
    all,
    settings: {
      volumeBoost: clampNumber(Number(forDomain.volumeBoost ?? DEFAULTS.volumeBoost), 1, 6),
      speed: clampNumber(Number(forDomain.speed ?? DEFAULTS.speed), 0.1, 16),
      nightMode: Boolean(forDomain.nightMode ?? DEFAULTS.nightMode),
      pitchSemitones: clampNumber(Number(forDomain.pitchSemitones ?? DEFAULTS.pitchSemitones), -12, 12),
    },
  };
}

async function saveDomainSettings(hostname, allDomainSettings, settings) {
  const nextAll = { ...allDomainSettings, [hostname]: { ...settings } };
  await browser.storage.local.set({ domainSettings: nextAll });
  return nextAll;
}

async function loadIsPro() {
  try {
    const stored = await browser.storage.local.get("isPro");
    return Boolean(stored.isPro ?? false);
  } catch {
    return false;
  }
}

async function saveIsPro(isPro) {
  try {
    await browser.storage.local.set({ isPro: Boolean(isPro) });
  } catch {
    // ignore
  }
}

async function loadTrialStartTime() {
  try {
    const stored = await browser.storage.local.get("trialStartTime");
    const t = stored.trialStartTime;
    return typeof t === "number" && t > 0 ? t : null;
  } catch {
    return null;
  }
}

async function saveTrialStartTime(timestamp) {
  try {
    if (timestamp == null) {
      await browser.storage.local.remove("trialStartTime");
    } else {
      await browser.storage.local.set({ trialStartTime: timestamp });
    }
  } catch {
    // ignore
  }
}

function getTrialRemainingMs(startTime) {
  if (!startTime) return 0;
  const elapsed = Date.now() - startTime;
  return Math.max(0, TRIAL_DURATION_MS - elapsed);
}

function isTrialActive(startTime) {
  return getTrialRemainingMs(startTime) > 0;
}

async function loadMyMix() {
  try {
    const stored = await browser.storage.local.get("myMix");
    const m = stored.myMix;
    if (!m || typeof m !== "object") return null;
    return {
      volumeBoost: clampNumber(Number(m.volumeBoost ?? 1), 1, 6),
      speed: clampNumber(Number(m.speed ?? 1), 0.1, 16),
      nightMode: Boolean(m.nightMode ?? false),
      pitchSemitones: clampNumber(Number(m.pitchSemitones ?? 0), -12, 12),
    };
  } catch {
    return null;
  }
}

async function saveMyMixToStorage(settings) {
  try {
    await browser.storage.local.set({
      myMix: {
        volumeBoost: settings.volumeBoost,
        speed: settings.speed,
        nightMode: settings.nightMode,
        pitchSemitones: settings.pitchSemitones,
      },
    });
  } catch {
    // ignore
  }
}

function setStatus(el, message) {
  el.textContent = message;
}

function setControlsEnabled(enabled) {
  const ids = ["volume", "speed", "nightMode", "pitch", "reset", "tabHome", "tabLicense", "licenseKey", "activate", "deactivate", "goPro", "startTrial", "presetMovie", "presetMusic", "presetPodcast", "presetMyMix", "saveMyMix", "trialOverlayUpgrade"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function setActiveTab(tabName) {
  const tabHome = document.getElementById("tabHome");
  const tabLicense = document.getElementById("tabLicense");
  const viewHome = document.getElementById("viewHome");
  const viewLicense = document.getElementById("viewLicense");

  const isHome = tabName === "home";
  tabHome.classList.toggle("tabActive", isHome);
  tabLicense.classList.toggle("tabActive", !isHome);
  viewHome.classList.toggle("viewHidden", !isHome);
  viewLicense.classList.toggle("viewHidden", isHome);
}

function renderProStatus(effectivePro) {
  const pill = document.getElementById("proPill");
  if (!pill) return;
  pill.textContent = effectivePro ? "PRO" : "FREE";
  pill.classList.toggle("pillPro", effectivePro);
}

/** Call after license or trial change to sync badge, locks, and pro/free controls. */
function refreshProUi(effectivePro) {
  renderProStatus(effectivePro);
  applyProGatingToUi(effectivePro);
}

/** Return preset settings clamped for current plan (free vs pro). myMix loads from storage. */
function presetForPlan(presetKey, isPro) {
  if (presetKey === "myMix") return null; // myMix is resolved async in applyPreset
  const p = PRESETS[presetKey];
  if (!p) return null;
  return sanitizeSettingsForPlan(p, isPro);
}

function renderUi(settings) {
  const volumeValue = document.getElementById("volumeValue");
  const speedValue = document.getElementById("speedValue");
  const pitchValue = document.getElementById("pitchValue");
  const volume = document.getElementById("volume");
  const speed = document.getElementById("speed");
  const nightMode = document.getElementById("nightMode");
  const pitch = document.getElementById("pitch");

  volume.value = String(settings.volumeBoost);
  speed.value = String(settings.speed);
  nightMode.checked = Boolean(settings.nightMode);
  pitch.value = String(settings.pitchSemitones);

  volumeValue.textContent = formatPercentFromBoost(settings.volumeBoost);
  speedValue.textContent = formatSpeed(settings.speed);
  pitchValue.textContent = String(settings.pitchSemitones);

  volume.classList.toggle("sliderUltraBoost", settings.volumeBoost > 3);
}

function applyProGatingToUi(isPro) {
  const lockUltra = document.getElementById("lockUltra");
  const lockNightMode = document.getElementById("lockNightMode");
  const lockPitch = document.getElementById("lockPitch");
  const lockViz = document.getElementById("lockViz");
  const lockPresets = document.getElementById("lockPresets");
  const proCta = document.getElementById("proCta");
  const vizWrap = document.getElementById("vizWrap");
  const vizStatus = document.getElementById("vizStatus");
  const presetRow = document.getElementById("presetRow");
  const startTrial = document.getElementById("startTrial");
  const saveMyMix = document.getElementById("saveMyMix");

  const nightModeRow = document.getElementById("nightModeRow");
  const nightModeInput = document.getElementById("nightMode");
  const pitchBlock = document.getElementById("pitchBlock");
  const pitchSlider = document.getElementById("pitch");
  const volumeSlider = document.getElementById("volume");

  // When PRO (or trial): hide all lock icons. When FREE: show all.
  const visibility = isPro ? "hidden" : "visible";
  lockUltra.style.visibility = visibility;
  if (lockNightMode) lockNightMode.style.visibility = visibility;
  if (lockPitch) lockPitch.style.visibility = visibility;
  if (lockViz) lockViz.style.visibility = visibility;
  if (lockPresets) lockPresets.style.visibility = visibility;

  if (presetRow) presetRow.classList.toggle("presetsLocked", !isPro);
  if (startTrial) startTrial.style.display = isPro ? "none" : "";
  if (saveMyMix) saveMyMix.classList.toggle("viewHidden", !isPro);

  if (!isPro) {
    if (nightModeRow) nightModeRow.classList.add("disabled");
    if (pitchBlock) pitchBlock.classList.add("disabled");
    nightModeInput.checked = false;
    nightModeInput.disabled = true;
    pitchSlider.value = "0";
    pitchSlider.disabled = true;
    volumeSlider.max = "3";
    vizWrap.classList.remove("viewHidden");
    vizWrap.classList.remove("vizLive");
    vizStatus.textContent = "\u{1F512}"; // lock icon
    proCta.classList.remove("viewHidden");
  } else {
    if (nightModeRow) nightModeRow.classList.remove("disabled");
    if (pitchBlock) pitchBlock.classList.remove("disabled");
    nightModeInput.disabled = false;
    pitchSlider.disabled = false;
    volumeSlider.max = "6";
    vizWrap.classList.remove("viewHidden");
    vizStatus.textContent = "—";
    proCta.classList.add("viewHidden");
  }
}

function sanitizeSettingsForPlan(rawSettings, isPro) {
  const s = rawSettings && typeof rawSettings === "object" ? rawSettings : DEFAULTS;
  const pro = Boolean(isPro);
  return {
    volumeBoost: clampNumber(Number(s.volumeBoost ?? 1), 1, pro ? 6 : 3),
    speed: clampNumber(Number(s.speed ?? 1), 0.1, 16),
    nightMode: pro ? Boolean(s.nightMode ?? false) : false,
    pitchSemitones: pro ? clampNumber(Number(s.pitchSemitones ?? 0), -12, 12) : 0,
  };
}

function readUiSettings(isPro) {
  const volumeMax = isPro ? 6 : 3;
  const volume = clampNumber(Number(document.getElementById("volume").value), 1, volumeMax);
  const speed = clampNumber(Number(document.getElementById("speed").value), 0.1, 16);
  const nightMode = isPro ? Boolean(document.getElementById("nightMode").checked) : false;
  const pitchSemitones = isPro
    ? clampNumber(Number(document.getElementById("pitch").value), -12, 12)
    : 0;
  return { volumeBoost: volume, speed, nightMode, pitchSemitones };
}

function createDebounced(fn, delayMs) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), delayMs);
  };
}

async function sendApplyMessage(tabId, hostname, settings) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "SSE_APPLY",
      hostname,
      settings,
    });
    return true;
  } catch {
    return false;
  }
}

async function ping(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: "SSE_PING" });
    return res && typeof res === "object" ? res : null;
  } catch {
    return null;
  }
}

async function getVizFrame(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: "SSE_GET_VIZ" });
    return res && typeof res === "object" ? res : null;
  } catch {
    return null;
  }
}

function drawVisualizer(canvas, levels, boost) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const n = Array.isArray(levels) ? levels.length : 0;
  if (n === 0) return;

  const mult = typeof boost === "number" && boost > 0 ? boost : 1;
  const gap = 2;
  const barW = Math.max(2, Math.floor((w - gap * (n - 1)) / n));
  let x = 0;
  for (let i = 0; i < n; i++) {
    const v = clampNumber(Number(levels[i]) * mult, 0, 1);
    const bh = Math.max(2, Math.floor(v * (h - 8)));
    const y = h - bh;

    const grad = ctx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, "#FF2E63");
    grad.addColorStop(1, "#AA2EE6");

    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x, y, barW, bh);
    x += barW + gap;
  }
  ctx.globalAlpha = 1;
}

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  try {
    await runPopupLogic(statusEl);
  } catch (err) {
    if (statusEl) statusEl.textContent = "Something went wrong.";
    setControlsEnabled(false);
  }
});

async function runPopupLogic(statusEl) {
  const tab = await getActiveTab();
  const hostname = tab ? getHostnameFromUrl(tab.url ?? "") : null;
  if (!tab || !hostname || typeof tab.id !== "number") {
    setControlsEnabled(false);
    setStatus(statusEl, "Open a normal website tab to use SonicSpeed.");
    return;
  }

  setControlsEnabled(true);
  setActiveTab("home");

  // Any click inside the popup counts as a user gesture; ask the content
  // script to resume its AudioContext so Web Audio can start safely.
  document.addEventListener(
    "click",
    () => {
      if (typeof tab.id === "number") {
        void browser.tabs.sendMessage(tab.id, { type: "SSE_RESUME_CTX" });
      }
    },
    { passive: true }
  );

  let isPro = await loadIsPro();
  let trialStartTime = await loadTrialStartTime();
  let showTrialEndedOverlay = false;
  if (trialStartTime && !isTrialActive(trialStartTime)) {
    try {
      await saveTrialStartTime(null);
    } catch {
      // ignore
    }
    trialStartTime = null;
    showTrialEndedOverlay = true;
  }
  let effectivePro = isPro || isTrialActive(trialStartTime);
  refreshProUi(effectivePro);
  if (showTrialEndedOverlay) {
    document.getElementById("trialEndedOverlay").classList.remove("viewHidden");
  }

  const { all, settings: storedSettings } = await loadDomainSettings(hostname).catch(() => ({ all: {}, settings: { ...DEFAULTS } }));
  const effectiveSettings = sanitizeSettingsForPlan(storedSettings, effectivePro);
  renderUi(effectiveSettings);

  // If not pro, clamp any previously-saved pro-only values.
  const clamped = sanitizeSettingsForPlan(storedSettings, effectivePro);
  if (
    clamped.volumeBoost !== storedSettings.volumeBoost ||
    clamped.nightMode !== storedSettings.nightMode ||
    clamped.pitchSemitones !== storedSettings.pitchSemitones
  ) {
    try {
      await browser.storage.local.set({
        domainSettings: { ...all, [hostname]: { ...storedSettings, ...clamped } },
      });
    } catch {
      // ignore
    }
  }

  const pingRes = await ping(tab.id);
  if (pingRes && pingRes.hasVideo === false) {
    setStatus(statusEl, `No <video> found on ${hostname}.`);
  } else {
    setStatus(statusEl, `Ready on ${hostname}.`);
  }

  let allDomainSettings = all;

  const volumeValue = document.getElementById("volumeValue");
  const speedValue = document.getElementById("speedValue");
  const pitchValue = document.getElementById("pitchValue");
  const vizCanvas = document.getElementById("viz");
  const vizStatus = document.getElementById("vizStatus");

  let vizTimer = 0;
  let vizInFlight = false;
  let popupClosed = false;

  function stopVisualizer() {
    popupClosed = true;
    if (vizTimer) {
      window.clearInterval(vizTimer);
      vizTimer = 0;
    }
  }

  const vizBoost = () => (effectivePro ? VIZ_BOOST_PRO : 1);

  const startVizLoop = () => {
    popupClosed = false;
    if (vizTimer) window.clearInterval(vizTimer);
    vizTimer = window.setInterval(async () => {
      if (popupClosed || !effectivePro) return;
      if (vizInFlight) return;
      vizInFlight = true;
      try {
        if (popupClosed) return;
        const frame = await getVizFrame(tab.id);
        if (popupClosed) return;
        if (!frame || frame.ok !== true) {
          vizStatus.textContent = "—";
          document.getElementById("vizWrap").classList.remove("vizLive");
          drawVisualizer(vizCanvas, [], 1);
          return;
        }
        vizStatus.textContent = frame.active ? "LIVE" : "IDLE";
        document.getElementById("vizWrap").classList.toggle("vizLive", frame.active);
        drawVisualizer(vizCanvas, frame.levels, vizBoost());
      } finally {
        vizInFlight = false;
      }
    }, 70);
  };
  // Visualizer runs only while popup is open; stop on close to save CPU/RAM.
  startVizLoop();
  window.addEventListener("unload", stopVisualizer, { passive: true });
  window.addEventListener("beforeunload", stopVisualizer, { passive: true });
  window.addEventListener("pagehide", stopVisualizer, { passive: true });

  let countdownTimer = 0;

  function updateTrialCountdown() {
    const el = document.getElementById("trialCountdown");
    if (!el) return;
    const rem = getTrialRemainingMs(trialStartTime);
    if (rem <= 0) {
      el.textContent = "";
      el.classList.add("viewHidden");
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = 0;
      }
      trialStartTime = null;
      effectivePro = isPro;
      saveTrialStartTime(null).then(() => {});
      refreshProUi(effectivePro);
      document.getElementById("trialEndedOverlay").classList.remove("viewHidden");
      return;
    }
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.textContent = `Trial: ${m}:${s.toString().padStart(2, "0")}`;
    el.classList.remove("viewHidden");
  }

  if (trialStartTime && isTrialActive(trialStartTime)) {
    updateTrialCountdown();
    countdownTimer = window.setInterval(updateTrialCountdown, 1000);
  } else {
    document.getElementById("trialCountdown").classList.add("viewHidden");
  }

  window.addEventListener("unload", () => { if (countdownTimer) clearInterval(countdownTimer); }, { passive: true });

  const debouncedApply = createDebounced(async () => {
    const nextSettings = readUiSettings(effectivePro);
    renderUi(nextSettings);
    try {
      allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, nextSettings);
    } catch {
      // ignore
    }
    const ok = await sendApplyMessage(tab.id, hostname, nextSettings);
    setStatus(
      statusEl,
      ok ? `Saved for ${hostname}.` : `Saved, but couldn't reach the page.`
    );
  }, 80);

  const volumeSliderEl = document.getElementById("volume");
  volumeSliderEl.addEventListener("input", (e) => {
    const v = clampNumber(Number(e.currentTarget.value), 1, effectivePro ? 6 : 3);
    volumeValue.textContent = formatPercentFromBoost(v);
    volumeSliderEl.classList.toggle("sliderUltraBoost", v > 3);
    debouncedApply();
  });

  document.getElementById("speed").addEventListener("input", (e) => {
    const s = clampNumber(Number(e.currentTarget.value), 0.1, 16);
    speedValue.textContent = formatSpeed(s);
    debouncedApply();
  });

  document.getElementById("nightMode").addEventListener("change", () => {
    debouncedApply();
  });

  document.getElementById("pitch").addEventListener("input", (e) => {
    const p = clampNumber(Number(e.currentTarget.value), -12, 12);
    pitchValue.textContent = String(p);
    debouncedApply();
  });

  document.getElementById("startTrial").addEventListener("click", async () => {
    try {
      await saveTrialStartTime(Date.now());
      trialStartTime = Date.now();
      effectivePro = true;
      refreshProUi(effectivePro);
      updateTrialCountdown();
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = window.setInterval(updateTrialCountdown, 1000);
      startVizLoop();
      setStatus(statusEl, "Trial started. Enjoy Pro for 15 min.");
      const loaded = await loadDomainSettings(hostname).catch(() => ({ all: {}, settings: { ...DEFAULTS } }));
      const effective = sanitizeSettingsForPlan(loaded.settings, true);
      renderUi(effective);
      allDomainSettings = loaded.all;
      allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, effective);
      await sendApplyMessage(tab.id, hostname, effective);
    } catch {
      setStatus(statusEl, "Could not start trial.");
    }
  });

  document.getElementById("goPro").addEventListener("click", async () => {
    await browser.tabs.create({ url: PRO_URL });
  });

  function shakeGoPro() {
    const btn = document.getElementById("goPro");
    if (btn) {
      btn.classList.remove("goProShake");
      btn.offsetHeight;
      btn.classList.add("goProShake");
      setTimeout(() => btn.classList.remove("goProShake"), 400);
    }
  }

  document.getElementById("reset").addEventListener("click", async () => {
    const toSave = { ...DEFAULTS };
    renderUi(toSave);
    allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, toSave);
    const ok = await sendApplyMessage(tab.id, hostname, toSave);
    setStatus(statusEl, ok ? `Reset for ${hostname}.` : `Reset saved (page unreachable).`);
  });

  async function applyPreset(presetKey) {
    if (!effectivePro && presetKey !== "myMix") {
      shakeGoPro();
      return;
    }
    let settings;
    if (presetKey === "myMix") {
      settings = await loadMyMix();
      if (!settings) {
        setStatus(statusEl, "No mix saved. Use Save My Mix first.");
        return;
      }
      settings = sanitizeSettingsForPlan(settings, true);
    } else {
      settings = presetForPlan(presetKey, effectivePro);
    }
    if (!settings) return;
    renderUi(settings);
    try {
      allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, settings);
    } catch {
      // ignore
    }
    const ok = await sendApplyMessage(tab.id, hostname, settings);
    setStatus(statusEl, ok ? `Preset applied for ${hostname}.` : `Preset saved (page unreachable).`);
  }

  document.getElementById("presetMovie").addEventListener("click", () => void applyPreset("movie"));
  document.getElementById("presetMusic").addEventListener("click", () => void applyPreset("music"));
  document.getElementById("presetPodcast").addEventListener("click", () => void applyPreset("podcast"));
  document.getElementById("presetMyMix").addEventListener("click", () => void applyPreset("myMix"));

  document.getElementById("saveMyMix").addEventListener("click", async () => {
    const settings = readUiSettings(effectivePro);
    await saveMyMixToStorage(settings);
    setStatus(statusEl, "Mix saved!");
  });

  document.getElementById("trialEndedOverlay").addEventListener("click", (e) => {
    if (e.target.id === "trialOverlayUpgrade" || e.target.closest("#trialOverlayUpgrade")) {
      document.getElementById("trialEndedOverlay").classList.add("viewHidden");
      browser.tabs.create({ url: PRO_URL });
    }
  });
  document.getElementById("trialOverlayUpgrade").addEventListener("click", () => {
    document.getElementById("trialEndedOverlay").classList.add("viewHidden");
    browser.tabs.create({ url: PRO_URL });
  });

  document.getElementById("tabHome").addEventListener("click", () => setActiveTab("home"));
  document.getElementById("tabLicense").addEventListener("click", () => setActiveTab("license"));

  document.getElementById("activate").addEventListener("click", async () => {
    const raw = document.getElementById("licenseKey").value;
    const sanitized = sanitizeLicenseKeyInput(raw);
    if (!isLicenseKeyValidFormat(sanitized)) {
      setStatus(statusEl, "Invalid key format. Use only letters and numbers.");
      return;
    }
    const ok = sanitized === LICENSE_ACCEPTED_SANITIZED;
    try {
      await saveIsPro(ok);
    } catch {
      setStatus(statusEl, "Could not save license.");
      return;
    }
    isPro = ok;
    if (ok) {
      await saveTrialStartTime(null);
      trialStartTime = null;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = 0;
      document.getElementById("trialCountdown").classList.add("viewHidden");
      document.getElementById("trialEndedOverlay").classList.add("viewHidden");
    }
    effectivePro = isPro || isTrialActive(trialStartTime);
    refreshProUi(effectivePro);
    setStatus(statusEl, ok ? "Pro activated." : "Invalid key.");
    startVizLoop();
    const loaded = await loadDomainSettings(hostname).catch(() => ({ all: {}, settings: { ...DEFAULTS } }));
    const effective = sanitizeSettingsForPlan(loaded.settings, effectivePro);
    renderUi(effective);
    allDomainSettings = loaded.all;
    allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, effective);
    await sendApplyMessage(tab.id, hostname, effective);
  });

  document.getElementById("deactivate").addEventListener("click", async () => {
    try {
      await saveIsPro(false);
    } catch {
      // ignore
    }
    isPro = false;
    effectivePro = isTrialActive(trialStartTime);
    refreshProUi(effectivePro);
    setStatus(statusEl, "Pro disabled.");
    drawVisualizer(vizCanvas, [], 1);
    const loaded = await loadDomainSettings(hostname).catch(() => ({ all: {}, settings: { ...DEFAULTS } }));
    const effective = sanitizeSettingsForPlan(loaded.settings, effectivePro);
    renderUi(effective);
    allDomainSettings = loaded.all;
    allDomainSettings = await saveDomainSettings(hostname, allDomainSettings, effective);
    await sendApplyMessage(tab.id, hostname, effective);
  });
}


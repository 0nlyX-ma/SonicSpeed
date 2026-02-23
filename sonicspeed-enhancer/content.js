/* global browser */

const DEFAULTS = Object.freeze({
  volumeBoost: 1,
  speed: 1,
  nightMode: false,
  pitchSemitones: 0,
});

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sanitizeSettings(raw, isPro) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const pro = Boolean(isPro);
  const maxBoost = pro ? 6 : 3;
  return {
    volumeBoost: clampNumber(Number(obj.volumeBoost ?? DEFAULTS.volumeBoost), 1, maxBoost),
    speed: clampNumber(Number(obj.speed ?? DEFAULTS.speed), 0.1, 16),
    nightMode: pro ? Boolean(obj.nightMode ?? DEFAULTS.nightMode) : false,
    pitchSemitones: pro
      ? clampNumber(Number(obj.pitchSemitones ?? DEFAULTS.pitchSemitones), -12, 12)
      : 0,
  };
}

function getHostname() {
  try {
    return window.location.hostname || null;
  } catch {
    return null;
  }
}

async function loadIsPro() {
  const stored = await browser.storage.local.get("isPro");
  return Boolean(stored.isPro ?? false);
}

async function loadSettingsForHostname(hostname, isPro) {
  const stored = await browser.storage.local.get("domainSettings");
  const all = stored.domainSettings && typeof stored.domainSettings === "object"
    ? stored.domainSettings
    : {};
  return sanitizeSettings(all[hostname], isPro);
}

function getVideos() {
  return Array.from(document.querySelectorAll("video"));
}

const audioEngine = {
  ctx: null,
  pipelines: new WeakMap(),
  blockedVideos: new WeakSet(),
};

async function ensureAudioContext() {
  if (audioEngine.ctx) return audioEngine.ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioEngine.ctx = new Ctx({ latencyHint: "interactive" });
  return audioEngine.ctx;
}

function configureCompressor(compressor) {
  // Tuned to be audibly helpful without being too aggressive.
  compressor.threshold.value = -26;
  compressor.knee.value = 24;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
}

async function ensurePipelineForVideo(video) {
  if (audioEngine.blockedVideos.has(video)) return null;
  const existing = audioEngine.pipelines.get(video);
  if (existing) return existing;

  const ctx = await ensureAudioContext();
  if (!ctx) return null;

  try {
    const source = ctx.createMediaElementSource(video);

    // Bypass-safe routing:
    // - dry path: source -> dryGain -> destination (original audio)
    // - wet path: source -> wetPre -> (compressor|bypass) -> boostGain -> analyser -> wetGain -> destination
    const dryGain = ctx.createGain();
    const wetPre = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    const compSelGain = ctx.createGain();
    const bypassSelGain = ctx.createGain();
    const boostGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    const wetGain = ctx.createGain();

    configureCompressor(compressor);
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    dryGain.gain.value = 1;
    wetGain.gain.value = 0;
    wetPre.gain.value = 1;

    // Start in bypass mode for compressor.
    compSelGain.gain.value = 0;
    bypassSelGain.gain.value = 1;
    boostGain.gain.value = 1;

    source.connect(dryGain);
    dryGain.connect(ctx.destination);

    source.connect(wetPre);
    wetPre.connect(compressor);
    compressor.connect(compSelGain);
    wetPre.connect(bypassSelGain);
    compSelGain.connect(boostGain);
    bypassSelGain.connect(boostGain);
    boostGain.connect(analyser);
    analyser.connect(wetGain);
    wetGain.connect(ctx.destination);

    const pipe = {
      source,
      dryGain,
      wetPre,
      compressor,
      compSelGain,
      bypassSelGain,
      boostGain,
      analyser,
      wetGain,
      lastVizLevels: new Array(24).fill(0),
    };

    audioEngine.pipelines.set(video, pipe);

    if (ctx.state === "suspended") {
      // Resume attempts can fail without a user gesture; we retry on play/interaction.
      ctx.resume().catch(() => {});
    }

    video.addEventListener(
      "play",
      () => {
        if (audioEngine.ctx && audioEngine.ctx.state === "suspended") {
          audioEngine.ctx.resume().catch(() => {});
        }
      },
      { passive: true }
    );

    return pipe;
  } catch {
    audioEngine.blockedVideos.add(video);
    return null;
  }
}

async function applyAudioToVideo(video, settings) {
  const anyWet = settings.volumeBoost > 1 || settings.nightMode === true;
  if (!anyWet) {
    const existing = audioEngine.pipelines.get(video);
    if (existing) {
      existing.dryGain.gain.value = 1;
      existing.wetGain.gain.value = 0;
      existing.boostGain.gain.value = 1;
      existing.compSelGain.gain.value = 0;
      existing.bypassSelGain.gain.value = 1;
    }
    return;
  }

  const pipe = await ensurePipelineForVideo(video);
  if (!pipe) return;

  pipe.dryGain.gain.value = 0;
  pipe.wetGain.gain.value = 1;
  pipe.boostGain.gain.value = settings.volumeBoost;

  if (settings.nightMode) {
    pipe.compSelGain.gain.value = 1;
    pipe.bypassSelGain.gain.value = 0;
  } else {
    pipe.compSelGain.gain.value = 0;
    pipe.bypassSelGain.gain.value = 1;
  }
}

function applySpeedToVideo(video, speed) {
  try {
    video.playbackRate = speed;
    video.defaultPlaybackRate = speed;
  } catch {
    // ignore
  }
}

function setPreservesPitch(video, preserves) {
  try {
    // Standard-ish (not fully standardized across all engines).
    if ("preservesPitch" in video) video.preservesPitch = preserves;
    if ("mozPreservesPitch" in video) video.mozPreservesPitch = preserves;
    if ("webkitPreservesPitch" in video) video.webkitPreservesPitch = preserves;
  } catch {
    // ignore
  }
}

function applySpeedAndPitchToVideo(video, speed, pitchSemitones) {
  const semis = clampNumber(Number(pitchSemitones), -12, 12);
  const pitchFactor = Math.pow(2, semis / 12);

  // Default behavior: speed changes should preserve pitch.
  // If pitch shifting is requested, we disable pitch preservation and apply playbackRate factor.
  if (semis === 0) {
    setPreservesPitch(video, true);
    applySpeedToVideo(video, speed);
    return;
  }

  setPreservesPitch(video, false);
  applySpeedToVideo(video, speed * pitchFactor);
}

let currentIsPro = false;
let currentSettings = { ...DEFAULTS };

async function applySettingsToAllVideos(settings) {
  const next = sanitizeSettings(settings, currentIsPro);
  currentSettings = next;

  const vids = getVideos();
  for (const v of vids) {
    applySpeedAndPitchToVideo(v, next.speed, next.pitchSemitones);
    await applyAudioToVideo(v, next);
  }
}

function startVideoObserver() {
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === "VIDEO") {
          const v = /** @type {HTMLVideoElement} */ (node);
          applySpeedAndPitchToVideo(v, currentSettings.speed, currentSettings.pitchSemitones);
          void applyAudioToVideo(v, currentSettings);
        } else {
          const nested = node.querySelectorAll ? node.querySelectorAll("video") : [];
          if (!nested || nested.length === 0) continue;
          for (const v of nested) {
            applySpeedAndPitchToVideo(v, currentSettings.speed, currentSettings.pitchSemitones);
            void applyAudioToVideo(v, currentSettings);
          }
        }
      }
    }
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });
}

function computeVizLevels(analyser, barCount) {
  const freq = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freq);

  const n = Math.max(8, Math.min(64, barCount));
  const out = new Array(n);
  const step = Math.max(1, Math.floor(freq.length / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < step; j++) {
      const idx = i * step + j;
      if (idx >= freq.length) break;
      sum += freq[idx];
      count++;
    }
    const avg = count ? sum / count : 0;
    out[i] = clampNumber(avg / 255, 0, 1);
  }
  return out;
}

function getPrimaryPipeline() {
  const vids = getVideos();
  // Prefer playing/unmuted videos.
  const playing = vids.find((v) => !v.paused && !v.ended) || vids[0] || null;
  if (!playing) return null;
  const pipe = audioEngine.pipelines.get(playing) || null;
  return { video: playing, pipe };
}

function init() {
  const hostname = getHostname();
  if (!hostname) return;

  void (async () => {
    currentIsPro = await loadIsPro();
    const stored = await loadSettingsForHostname(hostname, currentIsPro);
    await applySettingsToAllVideos(stored);
  })();

  startVideoObserver();

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    void (async () => {
      if (changes.isPro) currentIsPro = Boolean(changes.isPro.newValue);
      if (changes.domainSettings || changes.isPro) {
        const stored = await loadSettingsForHostname(hostname, currentIsPro);
        await applySettingsToAllVideos(stored);
      }
    })();
  });

  browser.runtime.onMessage.addListener((msg) => {
    const m = msg && typeof msg === "object" ? msg : {};
    if (m.type === "SSE_PING") {
      return Promise.resolve({ hasVideo: getVideos().length > 0 });
    }
    if (m.type === "SSE_APPLY") {
      return (async () => {
        const settings = sanitizeSettings(m.settings, currentIsPro);
        await applySettingsToAllVideos(settings);
        return { ok: true };
      })();
    }
    if (m.type === "SSE_GET_VIZ") {
      if (!currentIsPro) return Promise.resolve({ ok: false, reason: "not_pro" });
      const primary = getPrimaryPipeline();
      if (!primary) return Promise.resolve({ ok: true, active: false, levels: [] });

      const isPlaying = !primary.video.paused && !primary.video.ended;
      let pipe = primary.pipe;
      if (!pipe) {
        pipe = await ensurePipelineForVideo(primary.video);
        if (!pipe) return Promise.resolve({ ok: true, active: false, levels: [] });
      }

      const levels = computeVizLevels(pipe.analyser, 24);
      pipe.lastVizLevels = levels;
      return Promise.resolve({ ok: true, active: isPlaying, levels });
    }
    return undefined;
  });
}

init();


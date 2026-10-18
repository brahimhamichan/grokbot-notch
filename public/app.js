import {
  createMotionEngine,
  createStateMachine,
  buildFrameSvgTree,
  patchSvgDom,
  normalizeBodyShape,
  createAppearance,
  colorTokens,
  pointerToGaze,
  renderStillSvg
} from "/motion-lab.js";

const isNativeHost =
  Boolean(window.webkit?.messageHandlers?.notchHost) ||
  new URLSearchParams(location.search).get("native") === "1";

if (!isNativeHost) {
  document.body.classList.add("browser-preview");
}

function postNativeMessage(payload) {
  try {
    window.webkit?.messageHandlers?.notchHost?.postMessage(payload);
  } catch {}
}

// UI Sound Effects
// Media elements can't stream from the app's custom scheme, so each sound is fetched once into a blob URL.
const SOUND_FILES = { open: "open-blip", tick: "tick", doubleTick: "double-tick", chimeA: "chime-a", chimeB: "chime-b" };
const SOUNDS = {};
for (const [name, file] of Object.entries(SOUND_FILES)) {
  const audio = new Audio();
  audio.volume = 0.4;
  SOUNDS[name] = audio;
  fetch(`/sounds/${file}.wav`).then((r) => r.blob()).then((b) => { audio.src = URL.createObjectURL(b); }).catch(() => {});
}
function playUiSound(name) {
  if (!state.prefs.sounds) return;
  try {
    const snd = SOUNDS[name];
    if (!snd) return;
    snd.currentTime = 0;
    snd.play().catch(() => {});
  } catch {}
}

// Authentic Grok Bot Voice Call Connect (E5->B5) & Hangup (B5->E5) Chimes
function playCallChime(kind = "connect") {
  if (!state.prefs.sounds) return;
  try {
    const sampleRate = 24000;
    const notes =
      kind === "connect"
        ? [{ frequencyHz: 659.25, durationMs: 90 }, { frequencyHz: 987.77, durationMs: 150 }]
        : [{ frequencyHz: 987.77, durationMs: 90 }, { frequencyHz: 659.25, durationMs: 150 }];
    const counts = notes.map((n) => Math.max(1, Math.round((n.durationMs / 1000) * sampleRate)));
    const attack = Math.max(1, Math.round((6 / 1000) * sampleRate));
    const total = counts.reduce((a, b) => a + b, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < notes.length; i++) {
      const len = counts[i];
      const freq = notes[i].frequencyHz;
      for (let j = 0; j < len; j++) {
        const envIn = Math.min(1, j / attack);
        const envOut = (1 - j / len) ** 2;
        samples[offset + j] = 0.16 * envIn * envOut * Math.sin((2 * Math.PI * freq * j) / sampleRate);
      }
      offset += len;
    }
    const ctx = new AudioContext({ sampleRate });
    const buf = ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => ctx.close().catch(() => {});
    src.start();
  } catch {
    playUiSound(kind === "connect" ? "chimeA" : "chimeB");
  }
}

// State: starts collapsed ("start collapsed similar to how it is. then this on expand.")
const state = {
  expanded: false,
  typing: false,
  sendingText: false,
  activeAccountScope: null,
  bots: [],
  voices: [],
  prefs: { sounds: true, hoverToOpen: true, showOnAllScreens: true },
  settingsOpen: false,
  selectedBotId: null,
  statusCaption: "",
  call: {
    phase: "idle", // "idle" | "connecting" | "live"
    activity: "quiet", // "quiet" | "caller-speaking" | "agent-thinking" | "agent-speaking" | "working"
    callId: null,
    isMuted: false,
    energy: 0
  }
};

const dom = {
  pouch: document.getElementById("notch-pouch"),
  collapsedBar: document.getElementById("collapsed-bar"),
  collapsedMark: document.getElementById("collapsed-mark"),
  collapsedName: document.getElementById("collapsed-name"),
  botCharacterBtn: document.getElementById("bot-character-btn"),
  botMarkMount: document.getElementById("bot-mark-mount"),
  mainStarBadge: document.getElementById("main-star-badge"),
  botNameLabel: document.getElementById("bot-name-label"),
  botStatusCaption: document.getElementById("bot-status-caption"),
  prevBotBtn: document.getElementById("prev-bot-btn"),
  nextBotBtn: document.getElementById("next-bot-btn"),
  audioWavesBtn: document.getElementById("audio-waves-btn"),
  audioWavesBars: document.getElementById("audio-waves-bars"),
  collapsedWaves: document.querySelector(".collapsed-waves"),
  typeForm: document.getElementById("type-form"),
  typeInput: document.getElementById("type-input"),
  muteBtn: document.getElementById("mute-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsCloseBtn: document.getElementById("settings-close-btn"),
  settingsBotName: document.getElementById("settings-bot-name"),
  settingsVoice: document.getElementById("settings-voice"),
  settingsSpeed: document.getElementById("settings-speed"),
  prefSwitches: document.querySelectorAll("[data-pref]")
};

function getSelectedBot() {
  return state.bots.find((b) => b.id === state.selectedBotId) || state.bots[0] || null;
}

// Exact flat color palette matching Grok Bot dark mode (with softer, less harsh blue)
const FLAT_BOT_PALETTE = {
  violet: "#8e59f8",
  red: "#f73643",
  brown: "#a16b39",
  yellow: "#f59312",
  orange: "#f4650e",
  green: "#13bb6b",
  cyan: "#12b39f",
  magenta: "#f63397",
  blue: "#3d8df5",
  black: "#ffffff",
  gray: "#a6a6a6"
};

function getFlatBotInk(colorId) {
  if (FLAT_BOT_PALETTE[colorId]) return FLAT_BOT_PALETTE[colorId];
  const tok = colorTokens[colorId] || colorTokens.violet;
  return tok.dark;
}

// ============================================================================
// FLAT GROK BOT CHARACTER ENGINE (Exact Flat Style from Image 1)
// ============================================================================
const botEngine = createMotionEngine({ body: "hex" });
const botStateMachine = createStateMachine(botEngine, "idle", {
  seed: 101,
  isCompact: false,
  isResting: false
});

let lastTick = performance.now();

function currentMotionState() {
  if (state.call.phase === "connecting") return "waking";
  if (state.call.phase === "live") {
    switch (state.call.activity) {
      case "caller-speaking":
        return "listening";
      case "agent-thinking":
        return "thinking";
      case "agent-speaking":
        return "streaming";
      case "working":
        return "working";
      default:
        return "listening";
    }
  }
  if (state.sendingText) return "thinking";
  return "idle";
}

function syncCharacterToBot(bot) {
  if (!bot) return;
  const bodyShape = normalizeBodyShape(bot.avatarShape || "blob");
  botEngine.setBody(bodyShape);
  const ink = getFlatBotInk(bot.avatarColor);
  document.documentElement.style.setProperty("--bot-ink", ink);

  // Bots with a profile photo in Grok Bot show it; the rest use their flat character.
  dom.pouch.dataset.photo = String(Boolean(bot.avatarPhotoUrl));
  if (bot.avatarPhotoUrl) {
    if (dom.botMarkMount.dataset.photoFor !== bot.id) {
      dom.botMarkMount.dataset.photoFor = bot.id;
      dom.botMarkMount.replaceChildren(Object.assign(new Image(), { src: bot.avatarPhotoUrl, alt: bot.name, className: "bot-photo" }));
    }
    dom.collapsedMark.replaceChildren(Object.assign(new Image(), { src: bot.avatarPhotoUrl, alt: "", className: "bot-photo" }));
    dom.collapsedName.textContent = bot.name;
    return;
  }
  if (dom.botMarkMount.dataset.photoFor) {
    delete dom.botMarkMount.dataset.photoFor;
    dom.botMarkMount.replaceChildren();
  }

  // Collapsed bar mini flat mark
  dom.collapsedMark.innerHTML = renderStillSvg({
    body: bodyShape,
    ink,
    size: 16,
    id: "collapsed-still-mark"
  });
  dom.collapsedName.textContent = bot.name;
}

function tickAnimation(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  const bot = getSelectedBot();
  if (bot && state.expanded) {
    const desired = currentMotionState();
    botStateMachine.setState(desired);
    botStateMachine.advance(dt);
    botEngine.advance(dt);

    const ink = getFlatBotInk(bot.avatarColor);
    const flatAppearance = createAppearance(ink); // Pure flat silhouette with cutout eyes
    const tree = buildFrameSvgTree(botEngine.frame(), flatAppearance, 184, "pouch-bot-mark", {
      displaySize: 92,
      extent: "100%"
    });
    if (!bot.avatarPhotoUrl) patchSvgDom(dom.botMarkMount, tree);

  }
  // Waves animate in both states: the expanded pouch and the collapsed notch bar.
  renderAudioWaveBars(now);

  requestAnimationFrame(tickAnimation);
}

// Idle wave pattern matching whiteboard sketch "||||..||l|.." + live audio reactivity
const IDLE_WAVE_PATTERN = [11, 14, 10, 15, 4, 4, 12, 16, 9, 13, 4, 4, 11, 15, 9];

// Rolling energy history: during a call each bar is a past moment of audio, so the waveform scrolls left like a live meter.
const waveHistory = [];
let smoothedEnergy = 0;
let lastWaveSample = 0;

function renderAudioWaveBars(now) {
  const isLive = state.call.phase === "live";
  const isConnecting = state.call.phase === "connecting";
  const target = Math.max(0, Math.min(1, state.call.energy));
  // Fast attack, slower release reads like real speech instead of flicker.
  smoothedEnergy += (target - smoothedEnergy) * (target > smoothedEnergy ? 0.55 : 0.12);
  if (now - lastWaveSample > 38) {
    lastWaveSample = now;
    waveHistory.push(smoothedEnergy);
    if (waveHistory.length > 64) waveHistory.shift();
  }

  const levelAt = (i, count) => waveHistory[waveHistory.length - count + i] ?? 0;
  const heightFor = (i, count, max, base) => {
    if (isLive) {
      const shimmer = 0.85 + 0.15 * Math.sin(now * 0.02 + i * 1.7);
      return 3 + Math.pow(levelAt(i, count), 0.7) * (max - 3) * shimmer;
    }
    if (isConnecting) return 4 + (max * 0.4) * (0.5 + 0.5 * Math.sin(now * 0.008 + i * 0.45));
    return Math.max(3, base * 0.5); // Static when no call is in progress.
  };

  const bars = dom.audioWavesBars.querySelectorAll("span");
  bars.forEach((bar, i) => {
    const base = IDLE_WAVE_PATTERN[i % IDLE_WAVE_PATTERN.length];
    bar.style.height = `${Math.round(Math.min(22, heightFor(i, bars.length, 22, base)))}px`;
  });
  const mini = dom.collapsedWaves?.querySelectorAll("i") || [];
  mini.forEach((bar, i) => {
    bar.style.height = `${Math.round(Math.min(12, heightFor(i, mini.length, 12, [4, 8, 6, 5][i] || 5)))}px`;
  });
}

function updateGaze(clientX, clientY) {
  if (!state.expanded) return;
  const rect = dom.botMarkMount.getBoundingClientRect();
  if (rect.width > 0) {
    botEngine.setGaze(pointerToGaze(rect, { x: clientX, y: clientY }, 2.5));
  }
}

window.addEventListener(
  "pointermove",
  (e) => {
    updateGaze(e.clientX, e.clientY);
  },
  { passive: true }
);

// ============================================================================
// NATIVE HIT-RECT SYNC
// ============================================================================
function reportHitRectToNative() {
  const rect = dom.pouch.getBoundingClientRect();
  const bot = getSelectedBot();
  postNativeMessage({
    type: "hitRect",
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    isOpen: state.expanded,
    isTyping: state.typing || state.settingsOpen, // settings, like typing, keeps the notch open and frees the arrow keys
    callPhase: state.call.phase,
    botName: bot?.name || "Grok Bot"
  });
}

const resizeObserver = new ResizeObserver(() => reportHitRectToNative());
resizeObserver.observe(dom.pouch);

function setExpanded(expanded, { silent = false } = {}) {
  const next = Boolean(expanded);
  if (state.expanded === next) return;
  state.expanded = next;
  dom.pouch.dataset.expanded = String(next);
  if (!next) setSettingsOpen(false);
  if (next) {
    if (!silent) playUiSound("open");
    refreshBootstrap();
  } else {
    setTypingMode(false);
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

function setTypingMode(typing, initialChar = "") {
  state.typing = Boolean(typing);
  dom.pouch.dataset.typing = String(state.typing);
  dom.audioWavesBtn.hidden = state.typing;
  dom.typeForm.hidden = !state.typing;
  if (state.typing) {
    if (initialChar) {
      dom.typeInput.value = initialChar;
    }
    setTimeout(() => {
      dom.typeInput.focus();
      const len = dom.typeInput.value.length;
      dom.typeInput.setSelectionRange(len, len);
    }, 20);
  } else {
    dom.typeInput.blur();
  }
  reportHitRectToNative();
}

// ============================================================================
// AUDIO PIPELINE (Native AVAudioEngine + WebAudio 24kHz Fallback)
// ============================================================================
class VoiceAudioPipeline {
  constructor({ onPcm16Base64, onSpeechEnded, onEnergy }) {
    this.onPcm16Base64 = onPcm16Base64;
    this.onSpeechEnded = onSpeechEnded;
    this.onEnergy = onEnergy;
    this.useNativeAudio = isNativeHost && Boolean(window.webkit?.messageHandlers?.notchHost);
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.silentGain = null;
    this.scheduledSources = new Set();
    this.speakingSpans = new Map();
    this.playbackCursor = 0;
    this.speechDrainedResolvers = [];
  }

  async start() {
    if (this.useNativeAudio) {
      window.__onNativeMicFrame = (base64Pcm, rms) => {
        this.onEnergy?.(Math.min(1, Math.sqrt(rms) * 2.2));
        this.onPcm16Base64(base64Pcm);
      };
      window.__onNativeSpeakerEnergy = (rms) => {
        this.onEnergy?.(Math.min(1, rms * 3.8));
      };
      window.__onNativeMicDenied = () => {
        state.statusCaption = "Mic blocked — allow GrokBot Notch in Settings › Privacy › Microphone";
        renderPouch();
      };
      window.__onNativeSpeechEnded = () => {
        for (const r of this.speechDrainedResolvers.splice(0)) r();
        this.onSpeechEnded?.();
      };
      postNativeMessage({ type: "audioStart" });
      return;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.ctx = new AudioContext({ sampleRate: 24000 });
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      const floatSamples = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      const int16 = new Int16Array(floatSamples.length);
      for (let i = 0; i < floatSamples.length; i++) {
        const s = Math.max(-1, Math.min(1, floatSamples[i]));
        sum += s * s;
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      const rms = Math.sqrt(sum / floatSamples.length);
      if (this.scheduledSources.size === 0) {
        this.onEnergy?.(Math.min(1, rms * 5));
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      this.onPcm16Base64(btoa(binary));
    };
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  speakBase64Pcm16({ base64, itemId, contentIndex = 0 }) {
    if (this.useNativeAudio) {
      const nowSec = performance.now() / 1000;
      const byteLen = Math.floor((base64.length * 3) / 4);
      const durationSec = Math.floor(byteLen / 2) / 24000;
      const startSec = Math.max(nowSec, this.playbackCursor);
      this.playbackCursor = startSec + durationSec;
      if (itemId) {
        const key = `${itemId}:${contentIndex}`;
        const existing = this.speakingSpans.get(key);
        if (!existing) {
          this.speakingSpans.set(key, { itemId, contentIndex, startsAt: startSec, endsAt: this.playbackCursor });
        } else {
          existing.endsAt = this.playbackCursor;
        }
      }
      postNativeMessage({ type: "audioPlay", base64, itemId, contentIndex });
      return;
    }

    if (!this.ctx) return;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    let sum = 0;
    for (let i = 0; i < int16.length; i++) {
      const f = int16[i] / 32768;
      float32[i] = f;
      sum += f * f;
    }
    this.onEnergy?.(Math.min(1, Math.sqrt(sum / float32.length) * 3.8));

    const buffer = this.ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime, this.playbackCursor);
    src.start(startAt);
    this.scheduledSources.add(src);
    this.playbackCursor = startAt + buffer.duration;

    if (itemId) {
      const key = `${itemId}:${contentIndex}`;
      const span = this.speakingSpans.get(key);
      if (!span) {
        this.speakingSpans.set(key, { itemId, contentIndex, startsAt: startAt, endsAt: this.playbackCursor });
      } else {
        span.endsAt = this.playbackCursor;
      }
    }

    src.onended = () => {
      this.scheduledSources.delete(src);
      if (this.scheduledSources.size === 0) {
        this.speakingSpans.clear();
        this.onEnergy?.(0);
        for (const r of this.speechDrainedResolvers.splice(0)) r();
        this.onSpeechEnded?.();
      }
    };
  }

  dropScheduledSpeechForBargeIn() {
    const cuts = [];
    const nowSec = this.useNativeAudio ? performance.now() / 1000 : (this.ctx?.currentTime ?? 0);
    for (const span of this.speakingSpans.values()) {
      if (nowSec < span.endsAt) {
        cuts.push({
          itemId: span.itemId,
          contentIndex: span.contentIndex,
          audioEndMs: Math.max(0, Math.round((nowSec - span.startsAt) * 1000))
        });
      }
    }
    this.speakingSpans.clear();
    this.playbackCursor = 0;

    if (this.useNativeAudio) {
      postNativeMessage({ type: "audioStopPlayback" });
    } else {
      for (const s of this.scheduledSources) {
        s.onended = null;
        try { s.stop(); s.disconnect(); } catch {}
      }
      this.scheduledSources.clear();
    }
    this.onEnergy?.(0);
    return cuts;
  }

  whenScheduledSpeechEnds() {
    if (!this.useNativeAudio && this.scheduledSources.size === 0) return Promise.resolve();
    if (this.useNativeAudio && performance.now() / 1000 >= this.playbackCursor) return Promise.resolve();
    return new Promise((resolve) => {
      this.speechDrainedResolvers.push(resolve);
      setTimeout(resolve, 4000);
    });
  }

  stop() {
    this.dropScheduledSpeechForBargeIn();
    if (this.useNativeAudio) {
      postNativeMessage({ type: "audioStop" });
      return;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try { this.processor.disconnect(); } catch {}
    }
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch {}
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
    }
  }
}

// ============================================================================
// VOICE CALL CONTROLLER
// ============================================================================
let activeSession = null;
let transcriptPollInterval = null;

async function startVoiceCall() {
  if (activeSession) {
    await stopVoiceCall();
  }
  const bot = getSelectedBot();
  if (!bot) return;

  setExpanded(true);
  state.call = {
    phase: "connecting",
    activity: "quiet",
    callId: null,
    isMuted: false,
    energy: 0
  };
  state.statusCaption = "Connecting…";
  renderPouch();

  try {
    const startRes = await fetch("/api/voice/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: bot.id,
        voiceId: bot.voiceId,
        voiceSpeed: bot.voiceSpeed,
        voiceLanguage: bot.voiceLanguage
      })
    }).then((r) => r.json());

    if (!startRes.ok) {
      throw new Error(startRes.error || "Could not start voice call");
    }

    const { callId, credential, plan } = startRes;
    state.call.callId = callId;

    const wsUrl = new URL(credential.websocketUrl);
    wsUrl.searchParams.set("model", credential.model);

    const ws = new WebSocket(wsUrl.toString(), [`xai-client-secret.${credential.clientSecret}`]);
    ws.binaryType = "arraybuffer";

    const assistantDeltas = new Map();
    const seenVoiceUpdateIds = new Set();
    let invitedModel = false;
    let greetingTimer = null;
    let callerIsSpeaking = false;
    let theyTalkedOverThisResponse = false;

    const audioPipeline = new VoiceAudioPipeline({
      onPcm16Base64: (base64) => {
        if (state.call.isMuted || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
      },
      onSpeechEnded: () => {
        if (state.call.phase === "live" && state.call.activity === "agent-speaking") {
          state.call.activity = "quiet";
          state.statusCaption = "Listening";
          renderPouch();
        }
      },
      onEnergy: (energy) => {
        state.call.energy = energy;
      }
    });

    await audioPipeline.start();

    activeSession = {
      ws,
      audioPipeline,
      sendWrittenTurn(text) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const eventId = `written-turn-${crypto.randomUUID()}`;
        ws.send(JSON.stringify({
          type: "async_update.add",
          event_id: eventId,
          async_update: {
            topic: "written_message",
            payload: [{ message: { type: "text", content: text.slice(0, 2000) }, timestampMs: Date.now() }]
          }
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
        return true;
      }
    };

    ws.addEventListener("open", () => {
      if (invitedModel || ws.readyState !== WebSocket.OPEN) return;
      invitedModel = true;
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          ...(bot.voiceId ? { voice: bot.voiceId } : {}),
          resumption: { enabled: true },
          instructions: plan.instructions,
          turn_detection: { type: "server_vad" },
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "grok-transcribe" } },
            output: { format: { type: "audio/pcm", rate: 24000 }, speed: bot.voiceSpeed || 1 }
          },
          tools: plan.tools
        }
      }));

      greetingTimer = setTimeout(() => {
        if (!callerIsSpeaking && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: plan.greeting.direction }
          }));
        }
      }, 350);
    });

    ws.addEventListener("message", async (ev) => {
      if (typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "session.created":
        case "session.updated": {
          if (state.call.phase !== "live") {
            state.call.phase = "live";
            state.statusCaption = "Listening";
            playCallChime("connect");
            renderPouch();
          }
          break;
        }

        case "input_audio_buffer.speech_started": {
          callerIsSpeaking = true;
          theyTalkedOverThisResponse = true;
          if (greetingTimer) {
            clearTimeout(greetingTimer);
            greetingTimer = null;
          }
          const cuts = audioPipeline.dropScheduledSpeechForBargeIn();
          for (const cut of cuts) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "conversation.item.truncate",
                item_id: cut.itemId,
                content_index: cut.contentIndex,
                audio_end_ms: cut.audioEndMs
              }));
            }
          }
          state.call.activity = "caller-speaking";
          state.statusCaption = "Listening…";
          renderPouch();
          break;
        }

        case "input_audio_buffer.speech_stopped": {
          callerIsSpeaking = false;
          state.call.activity = "agent-thinking";
          state.statusCaption = "Thinking…";
          renderPouch();
          break;
        }

        case "response.created": {
          theyTalkedOverThisResponse = false;
          state.call.activity = "agent-speaking";
          renderPouch();
          break;
        }

        case "response.audio.delta":
        case "response.output_audio.delta": {
          if (!theyTalkedOverThisResponse && !callerIsSpeaking && typeof msg.delta === "string") {
            state.call.activity = "agent-speaking";
            audioPipeline.speakBase64Pcm16({
              base64: msg.delta,
              itemId: msg.item_id || "assistant",
              contentIndex: msg.content_index ?? 0
            });
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const itemId = msg.item_id || "assistant";
          const nextText = (assistantDeltas.get(itemId) || "") + (msg.delta || "");
          assistantDeltas.set(itemId, nextText);
          state.statusCaption = nextText.trim();
          renderPouch();
          break;
        }

        case "response.function_call_arguments.done": {
          const toolCallId = msg.call_id;
          const toolName = msg.name;
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(msg.arguments || "{}");
          } catch {}
          await handleVoiceToolCall({
            ws,
            audioPipeline,
            bot,
            callId,
            plan,
            toolCallId,
            toolName,
            parsedArgs
          });
          break;
        }

        case "response.done":
        case "response.cancelled": {
          if (state.call.activity !== "caller-speaking") {
            state.call.activity = "quiet";
            renderPouch();
          }
          break;
        }
      }
    });

    ws.addEventListener("close", () => {
      if (activeSession?.ws === ws) {
        stopVoiceCall({ silentChime: false });
      }
    });

    if (transcriptPollInterval) clearInterval(transcriptPollInterval);
    transcriptPollInterval = setInterval(async () => {
      if (!activeSession || state.call.phase !== "live") return;
      try {
        const res = await fetch(`/api/bot/${encodeURIComponent(bot.id)}/transcript?callId=${encodeURIComponent(callId)}`).then((r) => r.json());
        if (Array.isArray(res?.voiceUpdates)) {
          for (const upd of res.voiceUpdates) {
            if (seenVoiceUpdateIds.has(upd.id)) continue;
            seenVoiceUpdateIds.add(upd.id);
            if (ws.readyState === WebSocket.OPEN && upd.text) {
              const eventId = `seeded-nudge-${crypto.randomUUID()}`;
              ws.send(JSON.stringify({
                type: "async_update.add",
                event_id: eventId,
                async_update: {
                  topic: "check_work",
                  payload: [{ message: { type: "text", content: upd.text }, timestampMs: Date.now() }]
                }
              }));
              ws.send(JSON.stringify({ type: "response.create" }));
            }
          }
        }
      } catch {}
    }, 2800);
  } catch (err) {
    await stopVoiceCall({ silentChime: true });
    state.statusCaption = err.message;
    renderPouch();
  }
}

async function handleVoiceToolCall({ ws, audioPipeline, bot, callId, plan, toolCallId, toolName, parsedArgs }) {
  state.call.activity = "working";
  state.statusCaption = "Working…";
  renderPouch();

  if (toolName === "end_the_call") {
    fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: bot.id, callId, name: toolName, input: parsedArgs })
    }).catch(() => {});
    await audioPipeline.whenScheduledSpeechEnds();
    await stopVoiceCall();
    return;
  }

  if (toolName === "send_task" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(plan.receipt?.output || { receipt: "under way" })
      }
    }));
  }

  try {
    const toolRes = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: bot.id,
        callId,
        name: toolName,
        input: parsedArgs,
        line: {
          theyJustTalked: true,
          newsOwed: false,
          receiptOwed: toolName === "send_task",
          alreadySpokeThisTurn: false
        }
      })
    }).then((r) => r.json());

    if (toolName !== "send_task" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify(toolRes.output || {})
        }
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  } catch (err) {
    if (toolName !== "send_task" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({ error: err.message })
        }
      }));
    }
  }
}

function toggleMute() {
  if (state.call.phase === "idle") return;
  state.call.isMuted = !state.call.isMuted;
  postNativeMessage({ type: "audioSetMuted", muted: state.call.isMuted });
  playUiSound("tick");
  renderPouch();
}

async function stopVoiceCall({ silentChime = false } = {}) {
  const wasLive = state.call.phase === "live";
  if (transcriptPollInterval) {
    clearInterval(transcriptPollInterval);
    transcriptPollInterval = null;
  }

  if (activeSession) {
    const sess = activeSession;
    activeSession = null;
    try { sess.audioPipeline.stop(); } catch {}
    try {
      if (sess.ws.readyState === WebSocket.OPEN || sess.ws.readyState === WebSocket.CONNECTING) {
        sess.ws.close(1000, "hang_up");
      }
    } catch {}
  }

  if (wasLive && !silentChime) {
    playCallChime("hangup");
  }

  state.call.phase = "idle";
  state.call.activity = "quiet";
  state.call.isMuted = false;
  state.call.energy = 0;
  postNativeMessage({ type: "audioSetMuted", muted: false });
  state.statusCaption = "";
  renderPouch();
  reportHitRectToNative();
}

// ============================================================================
// RENDER & BOT SELECTION
// ============================================================================
function renderPouch() {
  const bot = getSelectedBot();
  if (!bot) return;

  syncCharacterToBot(bot);

  dom.pouch.dataset.call = state.call.phase;
  if (state.settingsOpen) renderSettings();
  dom.pouch.dataset.muted = String(state.call.phase !== "idle" && state.call.isMuted);
  dom.muteBtn.setAttribute("aria-pressed", String(state.call.isMuted));
  dom.muteBtn.title = state.call.isMuted ? "Unmute microphone (⌘⇧M)" : "Mute microphone (⌘⇧M)";
  dom.botNameLabel.textContent = bot.name;
  dom.typeInput.placeholder = `Message ${bot.name}…`;

  // Show orange star badge on the primary/first pinned bot (or Chief)
  dom.mainStarBadge.hidden = !(bot.isPinned && state.bots.indexOf(bot) === 0);

  if (state.statusCaption) {
    dom.botStatusCaption.textContent = state.statusCaption;
    dom.botStatusCaption.hidden = false;
  } else {
    dom.botStatusCaption.hidden = true;
  }

  reportHitRectToNative();
}

async function selectBot(botId) {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  const wasCallActive = state.call.phase !== "idle";
  state.selectedBotId = bot.id;
  state.statusCaption = "";
  botEngine.poke("spin");
  renderPouch();

  fetch("/api/select-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId: bot.id })
  }).catch(() => {});

  if (wasCallActive) {
    await startVoiceCall();
  }
}

function cycleBot(delta) {
  if (state.bots.length === 0) return;
  const idx = state.bots.findIndex((b) => b.id === state.selectedBotId);
  const nextIdx = (idx + delta + state.bots.length) % state.bots.length;
  playUiSound("tick");
  selectBot(state.bots[nextIdx].id);
}

// ============================================================================
// EVENTS & SHORTCUTS
// ============================================================================
// ============================================================================
// SETTINGS SCREEN
// ============================================================================
function setSettingsOpen(open) {
  state.settingsOpen = Boolean(open);
  dom.pouch.dataset.settings = String(state.settingsOpen);
  if (state.settingsOpen) {
    setTypingMode(false);
    renderSettings();
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

function renderSettings() {
  for (const el of dom.prefSwitches) el.checked = Boolean(state.prefs[el.dataset.pref]);
  const bot = getSelectedBot();
  if (!bot) return;
  dom.settingsBotName.textContent = `· ${bot.name}`;
  const current = bot.voiceId || state.voices[0]?.id || "";
  dom.settingsVoice.replaceChildren(...state.voices.map((v) => Object.assign(new Option(v.label, v.id, false, v.id === current), { title: v.tag })));
  const speed = Number(bot.voiceSpeed || 1);
  for (const b of dom.settingsSpeed.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(Math.abs(Number(b.dataset.speed) - speed) < 0.05));
  }
}

async function saveVoiceSettings(patch) {
  const bot = getSelectedBot();
  if (!bot) return;
  Object.assign(bot, patch);
  renderSettings();
  await fetch("/api/voice/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: bot.id, ...patch })
  }).catch(() => {});
}

dom.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  playUiSound("tick");
  setSettingsOpen(true);
});
dom.settingsCloseBtn.addEventListener("click", () => setSettingsOpen(false));
dom.settingsVoice.addEventListener("change", () => saveVoiceSettings({ voiceId: dom.settingsVoice.value }));
dom.settingsSpeed.addEventListener("click", (e) => {
  const speed = e.target.closest("button")?.dataset.speed;
  if (speed) saveVoiceSettings({ voiceSpeed: Number(speed) });
});
for (const el of dom.prefSwitches) {
  el.addEventListener("change", () => {
    state.prefs[el.dataset.pref] = el.checked;
    postNativeMessage({ type: "setPref", key: el.dataset.pref, value: el.checked });
  });
}

dom.muteBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMute();
});

dom.collapsedBar.addEventListener("click", () => {
  setExpanded(true);
});

dom.botCharacterBtn.addEventListener("click", async () => {
  if (state.call.phase === "idle") {
    await startVoiceCall();
  } else {
    await stopVoiceCall();
  }
});

dom.prevBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.prevBotBtn.addEventListener("click", () => {
  cycleBot(-1);
});

dom.nextBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.nextBotBtn.addEventListener("click", () => {
  cycleBot(1);
});

dom.audioWavesBtn.addEventListener("click", () => {
  playUiSound("tick");
  setTypingMode(true);
});

dom.typeInput.addEventListener("blur", () => {
  if (dom.typeInput.value.trim().length === 0) {
    setTypingMode(false);
  }
});

let activeReplyPoll = null;

dom.typeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = dom.typeInput.value.trim();
  if (!text) {
    setTypingMode(false);
    return;
  }
  dom.typeInput.value = "";
  setTypingMode(false);
  playUiSound("doubleTick");

  const bot = getSelectedBot();
  if (!bot) return;

  if (activeSession && state.call.phase === "live") {
    activeSession.sendWrittenTurn(text);
    return;
  }

  if (activeReplyPoll) {
    clearInterval(activeReplyPoll);
    activeReplyPoll = null;
  }

  state.sendingText = true;
  state.statusCaption = "Sending…";
  renderPouch();

  let baselineIds = new Set();
  try {
    const before = await fetch(`/api/bot/${encodeURIComponent(bot.id)}/transcript`).then((r) => r.json());
    if (Array.isArray(before?.entries)) {
      baselineIds = new Set(before.entries.map((entry) => entry.id));
    }
  } catch {}

  try {
    const sendRes = await fetch(`/api/bot/${encodeURIComponent(bot.id)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).then((r) => r.json());

    if (!sendRes.ok) {
      throw new Error(sendRes.error || "Failed to send");
    }

    state.statusCaption = "Working…";
    renderPouch();

    let attempts = 0;
    const targetBotId = bot.id;
    activeReplyPoll = setInterval(async () => {
      attempts++;
      if (attempts > 25 || state.selectedBotId !== targetBotId) {
        clearInterval(activeReplyPoll);
        activeReplyPoll = null;
        state.sendingText = false;
        if (state.statusCaption === "Working…" || state.statusCaption === "Sending…") {
          state.statusCaption = "Sent ✓";
          renderPouch();
        }
        return;
      }
      try {
        const res = await fetch(`/api/bot/${encodeURIComponent(targetBotId)}/transcript`).then((r) => r.json());
        if (Array.isArray(res?.entries)) {
          const fresh = res.entries.filter((entry) => entry.role === "assistant" && !baselineIds.has(entry.id));
          if (fresh.length > 0) {
            clearInterval(activeReplyPoll);
            activeReplyPoll = null;
            state.sendingText = false;
            state.statusCaption = fresh[fresh.length - 1].text;
            botEngine.poke("nod");
            renderPouch();
          }
        }
      } catch {}
    }, 1500);
  } catch (err) {
    state.sendingText = false;
    state.statusCaption = err.message || "Failed to send";
    renderPouch();
  }
});

function toggleSettings() {
  if (!state.expanded) setExpanded(true);
  setSettingsOpen(!state.settingsOpen);
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === ",") {
    e.preventDefault();
    toggleSettings();
    return;
  }
  if (!state.expanded) return;
  if (state.settingsOpen) {
    if (e.key === "Escape") setSettingsOpen(false);
    return;
  }

  if (e.key === "Escape") {
    if (state.typing) {
      dom.typeInput.value = "";
      setTypingMode(false);
      return;
    }
    if (state.call.phase !== "idle") {
      stopVoiceCall();
      return;
    }
    setExpanded(false);
    return;
  }

  if (state.typing) return;

  if (e.key === "Enter") {
    // Enter starts or ends a call with the selected bot.
    e.preventDefault();
    if (state.call.phase === "idle") startVoiceCall();
    else stopVoiceCall();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    cycleBot(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    cycleBot(1);
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setTypingMode(true, e.key);
  }
});

// Native Host Commands (⌥Space toggle, ⌘⇧G voice call, Menu Bar bot selection)
window.__notchCommand = async (cmd) => {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "toggleExpand":
      setExpanded(!state.expanded);
      break;
    case "toggleVoiceCall":
      if (!state.expanded) setExpanded(true);
      if (state.call.phase === "idle") {
        await startVoiceCall();
      } else {
        await stopVoiceCall();
      }
      break;
    case "expand":
      setExpanded(true, { silent: Boolean(cmd.silent) });
      if (cmd.focusInput && state.call.phase === "idle") setTypingMode(true);
      break;
    case "setPrefs":
      state.prefs = { ...state.prefs, ...cmd.prefs };
      renderSettings();
      break;
    case "collapse":
      setExpanded(false);
      break;
    case "toggleSettings":
      toggleSettings();
      break;
    case "toggleMute":
      toggleMute();
      break;
    case "nextBot":
      cycleBot(1);
      break;
    case "prevBot":
      cycleBot(-1);
      break;
    case "escape":
      if (state.settingsOpen) {
        setSettingsOpen(false);
      } else if (state.typing) {
        dom.typeInput.value = "";
        setTypingMode(false);
      } else if (state.call.phase !== "idle") {
        await stopVoiceCall();
      } else if (state.expanded) {
        setExpanded(false);
      }
      break;
    case "selectBot":
      if (cmd.botId) {
        await selectBot(cmd.botId);
        setExpanded(true);
      }
      break;
    case "setNotchGeometry":
      if (cmd.notchWidth && cmd.notchWidth > 100) {
        document.documentElement.style.setProperty("--notch-width", `${cmd.notchWidth}px`);
      }
      if (cmd.notchHeight && cmd.notchHeight > 20) {
        document.documentElement.style.setProperty("--notch-height", `${cmd.notchHeight}px`);
      }
      reportHitRectToNative();
      break;
  }
};

window.__onNativeCursorMove = (localX, localY) => {
  updateGaze(localX, localY);
};

async function refreshBootstrap() {
  try {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    if (!data.ok || !Array.isArray(data.bots)) return;

    const accountChanged =
      state.activeAccountScope !== null &&
      data.activeAccountScope &&
      data.activeAccountScope !== state.activeAccountScope;

    const oldIds = state.bots.map((b) => b.id).join(",");
    const newIds = data.bots.map((b) => b.id).join(",");
    const rosterChanged = oldIds !== newIds;

    state.activeAccountScope = data.activeAccountScope || state.activeAccountScope;
    state.bots = data.bots;
    state.voices = data.voices || state.voices;

    if (accountChanged || !state.selectedBotId || !state.bots.some((b) => b.id === state.selectedBotId)) {
      state.selectedBotId = data.selectedBotId || state.bots[0]?.id || null;
      state.statusCaption = "";
    }

    if (accountChanged || rosterChanged) {
      renderPouch();
      postNativeMessage({
        type: "rosterLoaded",
        bots: state.bots.map((b) => ({ id: b.id, name: b.name, section: b.section })),
        selectedBotId: state.selectedBotId
      });
    }
  } catch {}
}

async function init() {
  requestAnimationFrame(tickAnimation);
  await refreshBootstrap();
  renderPouch();
  reportHitRectToNative();
  // Periodically check for account or bot roster changes in Desktop Grok Bot
  setInterval(refreshBootstrap, 4000);
}

init();

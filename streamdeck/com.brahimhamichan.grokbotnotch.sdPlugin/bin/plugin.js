// GrokBot Notch Stream Deck plugin: talks to the app over its private Unix socket (no network port).
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { callKey, muteKey, notchKey } from "./render.js";

const ACTION = { call: "com.brahimhamichan.grokbotnotch.call", mute: "com.brahimhamichan.grokbotnotch.mute", notch: "com.brahimhamichan.grokbotnotch.notch" };
const SOCKET = path.join(os.homedir(), "Library/Application Support/GrokBotNotch/control.sock");
const HOLD_MS = 450;
const BARS = 14;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("-") ? [...acc, [v.slice(1), a[i + 1]]] : acc), []));
const sd = new WebSocket(`ws://127.0.0.1:${args.port}`);
const keys = new Map(); // context → { action, settings }
let app = { phase: "idle", muted: false, botId: null, bots: [] };
let offline = true;
let history = new Array(BARS).fill(0);
let callStartedAt = 0;
let tick = 0;

const sendSD = (msg) => sd.readyState === WebSocket.OPEN && sd.send(JSON.stringify(msg));
const sendImage = (context, image) => sendSD({ event: "setImage", context, payload: { image, target: 0 } });
// Keys are flattened to PNG by the app (Stream Deck skips images nested in SVG); only the newest frame per key is shown.
let nextReq = 0;
const pending = new Map(); // reqId → context
const latestReq = new Map(); // context → reqId
function setImage(context, svg) {
  if (!conn) return sendImage(context, svg);
  const reqId = ++nextReq;
  pending.set(reqId, context);
  latestReq.set(context, reqId);
  sendApp({ cmd: "render", reqId, svg });
}

// --- App connection --------------------------------------------------------
let conn = null;
function connectApp() {
  const sock = net.createConnection(SOCKET);
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => { conn = sock; offline = false; sock.write('{"cmd":"getState"}\n'); renderAll(); });
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onAppMessage(JSON.parse(line)); } catch {}
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => { const was = !offline; conn = null; pending.clear(); offline = true; if (was) renderAll(); setTimeout(connectApp, 2000); });
}
const sendApp = (cmd) => conn?.write(`${JSON.stringify(cmd)}\n`);

function onAppMessage(msg) {
  if (msg.event === "energy") {
    history = [...history.slice(1), Math.min(1, msg.value || 0)];
    return;
  }
  if (msg.event === "rendered") {
    const context = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    if (context && latestReq.get(context) === msg.reqId && keys.has(context)) sendImage(context, msg.image);
    return;
  }
  if (msg.event !== "state") return;
  const prevPhase = app.phase;
  app = { phase: msg.phase || "idle", muted: Boolean(msg.muted), botId: msg.botId, bots: msg.bots || app.bots };
  if (app.phase === "live" && prevPhase !== "live") callStartedAt = Date.now();
  if (app.phase === "idle") history = new Array(BARS).fill(0);
  renderAll();
}

// --- Rendering ---------------------------------------------------------------
const agentFor = (settings) => app.bots.find((b) => b.id === settings.botId);
const elapsed = () => { const s = Math.floor((Date.now() - callStartedAt) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function render(context) {
  const k = keys.get(context);
  if (!k) return;
  if (k.action === ACTION.call) {
    const agent = agentFor(k.settings);
    const mine = agent && app.botId === agent.id && app.phase !== "idle";
    setImage(context, callKey({
      agent, offline, tick, history, elapsed: elapsed(),
      phase: mine ? app.phase : "idle",
      muted: mine && app.muted,
      busyElsewhere: !mine && app.phase !== "idle"
    }));
  } else if (k.action === ACTION.mute) {
    setImage(context, muteKey({ phase: app.phase, muted: app.muted, offline }));
  } else if (k.action === ACTION.notch) {
    setImage(context, notchKey({ offline }));
  }
}
function renderAll() { for (const c of keys.keys()) render(c); }

// Animate only the keys of the agent on a call (~10 fps, within Stream Deck's update budget).
setInterval(() => {
  if (offline || app.phase === "idle") return;
  tick++;
  for (const [c, k] of keys) if (k.action === ACTION.call && agentFor(k.settings)?.id === app.botId) render(c);
}, 100);

// --- Key handling --------------------------------------------------------------
const holds = new Map();
function keyDown(context, k) {
  if (k.action !== ACTION.call) return;
  holds.set(context, { fired: false, timer: setTimeout(() => {
    const h = holds.get(context);
    if (!h) return;
    h.fired = true;
    if (app.phase === "live" && agentFor(k.settings)?.id === app.botId) sendApp({ cmd: "mute" });
    else sendSD({ event: "showAlert", context });
  }, HOLD_MS) });
}
function keyUp(context, k) {
  if (k.action === ACTION.call) { const h0 = holds.get(context); if (h0) clearTimeout(h0.timer); }
  if (offline) { holds.delete(context); return sendSD({ event: "showAlert", context }); }
  if (k.action === ACTION.mute) return app.phase === "live" ? sendApp({ cmd: "mute" }) : sendSD({ event: "showAlert", context });
  if (k.action === ACTION.notch) return sendApp({ cmd: "toggleNotch" });
  const h = holds.get(context);
  holds.delete(context);
  if (h) clearTimeout(h.timer);
  if (h?.fired) return;
  const agent = agentFor(k.settings);
  if (!agent) return sendSD({ event: "showAlert", context });
  sendApp({ cmd: "call", botId: agent.id });
}

// --- Stream Deck events ---------------------------------------------------------
function sendAgents(context, action) {
  sendSD({ event: "sendToPropertyInspector", action, context, payload: { agents: app.bots.map((b) => ({ id: b.id, name: b.name })), offline } });
}

sd.on("open", () => { sendSD({ event: args.registerEvent, uuid: args.pluginUUID }); connectApp(); });
sd.on("message", (raw) => {
  const { event, action, context, payload = {} } = JSON.parse(raw);
  switch (event) {
    case "willAppear":
      keys.set(context, { action, settings: payload.settings || {} });
      render(context);
      break;
    case "willDisappear":
      clearTimeout(holds.get(context)?.timer);
      holds.delete(context);
      keys.delete(context);
      break;
    case "didReceiveSettings":
      if (keys.has(context)) keys.get(context).settings = payload.settings || {};
      render(context);
      break;
    case "keyDown":
      if (keys.has(context)) keyDown(context, keys.get(context));
      break;
    case "keyUp":
      if (keys.has(context)) keyUp(context, keys.get(context));
      break;
    case "propertyInspectorDidAppear":
    case "sendToPlugin":
      sendAgents(context, action);
      break;
  }
});
sd.on("close", () => process.exit(0));

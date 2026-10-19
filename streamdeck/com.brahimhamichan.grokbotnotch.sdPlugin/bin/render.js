// Key artwork as 144×144 SVG data URLs.
const S = 144;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (t, n = 11) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const url = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const frame = (body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="#000"/>${body}</svg>`;
const label = (text, color = "#fff", y = 130) => `<text x="72" y="${y}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial" font-size="19" font-weight="600" fill="${color}">${esc(text)}</text>`;

function avatar(agent, cx, cy, r, opacity = 1) {
  if (!agent?.image) {
    const initial = esc((agent?.name || "?").slice(0, 1).toUpperCase());
    return `<g opacity="${opacity}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${agent?.ink || "#555"}"/><text x="${cx}" y="${cy + r * 0.36}" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="${r}" font-weight="700" fill="#000">${initial}</text></g>`;
  }
  const isPhoto = !agent.image.startsWith("data:image/svg");
  const size = isPhoto ? r * 2 : r * 2.1;
  const img = `<image x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" href="${agent.image}" xlink:href="${agent.image}" preserveAspectRatio="xMidYMid ${isPhoto ? "slice" : "meet"}"${isPhoto ? ` clip-path="url(#c${r})"` : ""}/>`;
  return `<defs><clipPath id="c${r}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs><g opacity="${opacity}">${img}</g>`;
}

const micSlash = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="15" fill="#f73643"/><g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><rect x="-4" y="-9" width="8" height="12" rx="4"/><path d="M-7.5 0a7.5 7.5 0 0 0 15 0M0 7.5v3.5M-9 -9l18 18"/></g></g>`;

// Waveform: newest energy on the right, mirrored around the centre line.
function wave(history, color, top, height) {
  const n = history.length, gap = 4, w = (S - 24 - gap * (n - 1)) / n, mid = top + height / 2;
  return history.map((e, i) => {
    const h = Math.max(4, Math.min(height, 4 + e * height * 1.6));
    return `<rect x="${(12 + i * (w + gap)).toFixed(1)}" y="${(mid - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(w / 2).toFixed(1)}" fill="${color}"/>`;
  }).join("");
}

export function callKey({ agent, phase, muted, history, tick = 0, busyElsewhere, offline, elapsed }) {
  if (offline) return url(frame(avatar(agent, 72, 58, 40, 0.3) + label("Offline", "#888")));
  if (!agent) return url(frame(label("Choose", "#aaa", 70) + label("an agent", "#aaa", 96)));
  const ink = agent.ink || "#5aa9ff";
  if (phase === "connecting") {
    const p = (Math.sin(tick / 2.2) + 1) / 2;
    return url(frame(`<circle cx="72" cy="58" r="${46 + p * 6}" fill="none" stroke="${ink}" stroke-width="4" opacity="${0.3 + p * 0.7}"/>` + avatar(agent, 72, 58, 40) + label("Calling…", ink)));
  }
  if (phase === "live") {
    const color = muted ? "#555" : ink;
    return url(frame(
      `<circle cx="72" cy="36" r="29" fill="none" stroke="${color}" stroke-width="3"/>` + avatar(agent, 72, 36, 25) +
      (muted ? micSlash(98, 56, 0.8) : "") +
      wave(history, color, 74, 40) +
      label(muted ? "Muted" : elapsed || short(agent.name), muted ? "#f73643" : "#fff", 136)
    ));
  }
  return url(frame(avatar(agent, 72, 58, 40, busyElsewhere ? 0.35 : 1) + label(short(agent.name), busyElsewhere ? "#666" : "#fff")));
}

export function muteKey({ phase, muted, offline }) {
  const active = phase === "live" && !offline;
  const color = !active ? "#555" : muted ? "#f73643" : "#fff";
  const mic = `<g transform="translate(72 60)" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"><rect x="-13" y="-36" width="26" height="46" rx="13"/><path d="M-27 -2a27 27 0 0 0 54 0M0 25v12"/>${muted && active ? '<path d="M-34 -34l68 68"/>' : ""}</g>`;
  return url(frame(mic + label(!active ? "No call" : muted ? "Muted" : "Mute", color)));
}

export function notchKey({ offline }) {
  const color = offline ? "#555" : "#fff";
  return url(frame(`<rect x="22" y="34" width="100" height="60" rx="12" fill="none" stroke="${color}" stroke-width="6"/><path d="M50 34h44v10a8 8 0 0 1-8 8H58a8 8 0 0 1-8-8z" fill="${color}"/>` + label(offline ? "Offline" : "Notch", color)));
}

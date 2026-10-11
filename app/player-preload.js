// Runs at document start inside the youtube.com watch page that plays videos in Now Playing.
// Styling the page before its first paint means the player fills the screen from the start,
// instead of the normal page appearing and then being rearranged.
const CSS = `
  html, body, ytd-app { overflow: hidden !important; background: #000 !important; }
  #masthead-container, ytd-masthead, #secondary, #below, #comments, ytd-mealbar-promo-renderer,
  tp-yt-iron-overlay-backdrop, ytd-popup-container, .ytp-chrome-bottom, .ytp-chrome-top,
  .ytp-gradient-bottom, .ytp-gradient-top, .ytp-ce-element, .html5-endscreen, .ytp-pause-overlay,
  .ytp-autonav-endscreen-countdown-overlay, .ytp-paid-content-overlay, .ytp-cards-teaser,
  .ytp-watermark, .ytp-show-cards-title, .ytp-spinner { display: none !important; }
  #movie_player, #player-container-outer, #player-container-inner, #player-container, #ytd-player, ytd-player,
  #full-bleed-container, #player-full-bleed-container {
    position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
    max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important;
    padding: 0 !important; z-index: 2147483000 !important; background: #000 !important; }
  #movie_player .html5-video-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }
  #movie_player video { position: absolute !important; width: 100% !important; height: 100% !important;
    left: 0 !important; top: 0 !important; object-fit: contain !important; }
`;

function inject() {
  const style = document.createElement('style');
  style.id = 'wmp-player-style';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

if (document.documentElement) inject();
else new MutationObserver((_, obs) => { if (document.documentElement) { obs.disconnect(); inject(); } }).observe(document, { childList: true });

// YouTube sizes its player from window size; nudge it once the real layout exists.
window.addEventListener('DOMContentLoaded', () => window.dispatchEvent(new Event('resize')));

// Ad schedule removal (the technique uBlock Origin uses on YouTube): strip the ad fields from the
// player's data before the player reads them. It has to run in the page's own JavaScript world, and
// webFrame.executeJavaScript is used because YouTube's Trusted Types/CSP block injected <script> tags.
function pruneAds() {
  const KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const clean = (o) => {
    if (o && typeof o === 'object') {
      for (const k of KEYS) if (k in o) delete o[k];
      if (o.playerResponse) clean(o.playerResponse);
    }
    return o;
  };
  const parse = JSON.parse;
  JSON.parse = function (...args) { const r = parse.apply(this, args); try { clean(r); } catch (e) { /* not ours */ } return r; };
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.call(this).then((r) => { try { clean(r); } catch (e) { /* not ours */ } return r; }); };
  // The first video's ad schedule is inline in the page (var ytInitialPlayerResponse = {...}),
  // not parsed from JSON, so intercept that assignment too.
  let initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => initial, set: (v) => { initial = clean(v); } });
}
try {
  require('electron').webFrame.executeJavaScript(`(${pruneAds.toString()})()`);
} catch (e) { /* ad removal unavailable; the app still auto-skips ads */ }

// Visualizer: frequency bars drawn over the bottom of the video, in the page itself (that's where
// the audio is). YouTube may already route the video through its own Web Audio graph (a media
// element can only be tapped once), so createMediaElementSource is wrapped at document start to
// remember any source node YouTube makes; the analyser then listens on that node instead.
// The host turns it on/off with window.__wmpVis.set(bool).
function wmpVisualizer() {
  const sources = new WeakMap();
  const make = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (el) {
    const node = make.call(this, el);
    sources.set(el, node);
    return node;
  };

  let enabled = false, raf = 0, canvas = null, g = null, analyser = null, data = null, tapped = null, own = null;
  let peaks = [], peakHold = [];

  function tap() {
    const v = document.querySelector('#movie_player video');
    if (!v) return false;
    if (tapped === v) return true;
    let node = sources.get(v);
    if (!node) {
      own = own || new AudioContext();
      node = own.createMediaElementSource(v); // our own graph: must also feed the speakers
      node.connect(own.destination);
    }
    analyser = node.context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    data = new Uint8Array(analyser.frequencyBinCount);
    node.connect(analyser);
    tapped = v;
    return true;
  }

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return;
    canvas = document.createElement('canvas');
    canvas.id = 'wmp-vis';
    Object.assign(canvas.style, { position: 'fixed', left: '0', bottom: '0', width: '100vw', height: '24vh',
      zIndex: '2147483001', pointerEvents: 'none', display: 'none' });
    document.documentElement.appendChild(canvas);
    g = canvas.getContext('2d');
  }

  let lastDraw = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < 33) return;   // ~30 fps is plenty for bars and halves the work
    lastDraw = now;
    ensureCanvas();
    let ok = false;
    try { ok = tap(); } catch (e) { ok = false; }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    if (!ok || !w || !h) return;
    if (analyser.context.state === 'suspended') analyser.context.resume();
    analyser.getByteFrequencyData(data);

    // Styled after WMP11's glass: dark glossy band, luminous blue capsule bars with a white sheen
    // and soft glow (like the transport orb), glowing pill peak caps.
    const band = g.createLinearGradient(0, 0, 0, h);
    band.addColorStop(0, 'rgba(0, 0, 0, 0)');
    band.addColorStop(0.45, 'rgba(2, 6, 16, 0.35)');
    band.addColorStop(1, 'rgba(2, 6, 16, 0.72)');
    g.fillStyle = band;
    g.fillRect(0, 0, w, h);

    // Bars on a logarithmic frequency scale (~40 Hz to ~16 kHz).
    const n = Math.max(16, Math.min(64, Math.floor(w / (16 * dpr))));
    const gap = Math.max(3, Math.round(5 * dpr)), bw = (w - gap * (n + 1)) / n;
    const nyquist = analyser.context.sampleRate / 2, bins = data.length;
    const lo = Math.log(40), hi = Math.log(16000);
    const glass = g.createLinearGradient(0, h, 0, 0);
    glass.addColorStop(0, 'rgba(6, 22, 70, 0.95)');
    glass.addColorStop(0.35, 'rgba(18, 74, 200, 0.95)');
    glass.addColorStop(0.75, 'rgba(48, 132, 255, 0.95)');
    glass.addColorStop(1, 'rgba(150, 215, 255, 0.98)');
    const r = Math.min(bw / 2, 4 * dpr);
    const capsule = (x, y, cw, ch) => {
      g.beginPath();
      g.moveTo(x, y + ch); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
      g.lineTo(x + cw - r, y); g.quadraticCurveTo(x + cw, y, x + cw, y + r); g.lineTo(x + cw, y + ch);
      g.closePath();
    };
    if (peaks.length !== n) { peaks = new Array(n).fill(0); peakHold = new Array(n).fill(0); }
    for (let i = 0; i < n; i++) {
      const f0 = Math.exp(lo + (hi - lo) * i / n), f1 = Math.exp(lo + (hi - lo) * (i + 1) / n);
      const b0 = Math.floor(f0 / nyquist * bins), b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * bins));
      let m = 0;
      for (let b = b0; b < b1 && b < bins; b++) if (data[b] > m) m = data[b];
      const v = Math.pow(m / 255, 1.6);           // tame the low end so quiet passages stay low
      const bh = Math.max(2 * dpr, v * h * 0.86), x = gap + i * (bw + gap), y = h - bh;
      // glass body; the glow is a faint wider halo (canvas blur is expensive on the GPU)
      const halo = 2 * dpr;
      g.fillStyle = 'rgba(60, 150, 255, 0.16)';
      capsule(x - halo, y - halo, bw + halo * 2, bh + halo);
      g.fill();
      g.fillStyle = glass;
      capsule(x, y, bw, bh);
      g.fill();
      // sheen: a soft white highlight down the left of each bar, like the orb's reflection
      const sheen = g.createLinearGradient(x, 0, x + bw, 0);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
      sheen.addColorStop(0.3, 'rgba(255, 255, 255, 0.32)');
      sheen.addColorStop(0.55, 'rgba(255, 255, 255, 0.04)');
      sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = sheen;
      capsule(x, y, bw, bh);
      g.fill();
      // Peak caps: hold briefly, then fall.
      if (bh >= peaks[i]) { peaks[i] = bh; peakHold[i] = 18; }
      else if (peakHold[i] > 0) peakHold[i]--;
      else peaks[i] = Math.max(0, peaks[i] - h * 0.012);
      if (peaks[i] > 3 * dpr) {
        const cy = h - peaks[i] - 5 * dpr, ch = Math.max(2, 2.5 * dpr);
        g.save();
        g.fillStyle = 'rgba(120, 200, 255, 0.25)';
        g.fillRect(x - dpr, cy - dpr, bw + 2 * dpr, ch + 2 * dpr);
        g.fillStyle = 'rgba(205, 238, 255, 0.95)';
        g.beginPath();
        g.moveTo(x + ch / 2, cy); g.lineTo(x + bw - ch / 2, cy); g.arc(x + bw - ch / 2, cy + ch / 2, ch / 2, -Math.PI / 2, Math.PI / 2);
        g.lineTo(x + ch / 2, cy + ch); g.arc(x + ch / 2, cy + ch / 2, ch / 2, Math.PI / 2, Math.PI * 1.5);
        g.fill();
        g.restore();
      }
    }
  }

  window.__wmpVis = {
    set(on) {
      enabled = !!on;
      ensureCanvas();
      canvas.style.display = enabled ? 'block' : 'none';
      if (enabled && !raf) frame();
      if (!enabled && raf) { cancelAnimationFrame(raf); raf = 0; }
    },
  };
}
try {
  require('electron').webFrame.executeJavaScript(`(${wmpVisualizer.toString()})()`);
} catch (e) { /* visualizer unavailable */ }

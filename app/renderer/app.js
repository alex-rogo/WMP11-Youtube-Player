'use strict';
/* WMP11-skinned YouTube player. Skin images come from tools/build_skin.py; playback uses the
   YouTube IFrame Player API. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

// ---------------------------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------------------------
const S = {
  queue: [],            // [{id, title, channel, dur}]
  index: -1,
  shuffle: false,
  repeat: false,
  volume: 70,
  muted: false,
  listPane: true,
  timeMode: 'elapsed',
  position: 0,
  playlists: [],        // [{name, items}]
  history: [],
  captions: false,      // YouTube remembers CC per account; we set it per video
  visualizer: true,     // frequency bars over the bottom of the video (drawn in player-preload.js)
};
const PERSIST = ['queue', 'index', 'shuffle', 'repeat', 'volume', 'muted', 'listPane', 'timeMode', 'position', 'playlists', 'history', 'captions', 'visualizer'];
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {};
    for (const k of PERSIST) data[k] = S[k];
    host.storeSet(data);
  }, 400);
}

const current = () => S.queue[S.index] || null;
const thumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const ytUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// ---------------------------------------------------------------------------------------------
// Skin engine
// ---------------------------------------------------------------------------------------------
let L; // layout.json
const imgCache = new Map();
function loadImg(name) {
  if (!imgCache.has(name)) {
    imgCache.set(name, new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('missing skin image ' + name));
      im.src = `skin/${name}.png`;
    }));
  }
  return imgCache.get(name);
}

// Colours used in WMP's mapping images (see tools/build_skin.py).
const MAP_COLOURS = {
  cap_map: { min: [255, 255, 0], max: [0, 255, 0], close: [255, 0, 0] },
  nav_map: { back: [0, 255, 0], forward: [255, 255, 0] },
  round_map: { btn: [255, 0, 0] },
  tgroup_map: { stop: [255, 0, 0], prev: [0, 255, 255], play: [0, 255, 0], next: [0, 0, 255] },
  split_map: { mute: [255, 0, 0], popup: [0, 255, 0] },
};

/** A WMP "REGIONALBUTTON": one image per state, with a colour-coded map deciding which element
 *  the pointer is over. Hover/pressed/disabled states are painted only inside that element's region. */
class RegionalButton {
  constructor(host, { images, map, overlay, onClick, enabled, onHover, tip }) {
    this.host = host; this.images = images; this.mapName = map;
    this.overlay = overlay; this.onClick = onClick; this.enabled = enabled || (() => true);
    this.onHover = onHover; this.tip = tip || {};
    this.hover = null; this.pressed = null;
  }
  async init() {
    const names = Object.values(this.images).filter(Boolean);
    const [mapIm, ...ims] = await Promise.all([loadImg(this.mapName), ...names.map(loadImg)]);
    this.im = {}; Object.keys(this.images).filter((k) => this.images[k]).forEach((k, i) => { this.im[k] = ims[i]; });
    const w = mapIm.width, h = mapIm.height;
    this.w = w; this.h = h;
    const mc = new OffscreenCanvas(w, h).getContext('2d');
    mc.drawImage(mapIm, 0, 0);
    this.map = mc.getImageData(0, 0, w, h).data;
    this.colours = MAP_COLOURS[this.mapName];
    // Pre-composite each (state, element) layer.
    this.layers = {};
    for (const [el, rgb] of Object.entries(this.colours)) {
      const mask = new ImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if (this.map[o] === rgb[0] && this.map[o + 1] === rgb[1] && this.map[o + 2] === rgb[2]) mask.data[o + 3] = 255;
      }
      const maskC = new OffscreenCanvas(w, h); maskC.getContext('2d').putImageData(mask, 0, 0);
      for (const st of ['hover', 'down', 'disabled']) {
        if (!this.im[st]) continue;
        const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
        x.drawImage(this.im[st], 0, 0);
        x.globalCompositeOperation = 'destination-in';
        x.drawImage(maskC, 0, 0);
        this.layers[st + ':' + el] = c;
      }
    }
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px`;
    this.ctx = this.canvas.getContext('2d');
    this.host.style.width = w + 'px'; this.host.style.height = h + 'px';
    this.host.appendChild(this.canvas);
    this.bind();
    this.render();
    return this;
  }
  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(e.clientX - r.left), y = Math.floor(e.clientY - r.top);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const o = (y * this.w + x) * 4, d = this.map;
    for (const [el, rgb] of Object.entries(this.colours)) {
      if (d[o] === rgb[0] && d[o + 1] === rgb[1] && d[o + 2] === rgb[2]) return el;
    }
    return null;
  }
  setHover(el) {
    if (el === this.hover) return;
    this.hover = el;
    this.canvas.style.cursor = el && this.enabled(el) ? 'pointer' : '';
    this.canvas.title = (el && this.tip[el] && (typeof this.tip[el] === 'function' ? this.tip[el]() : this.tip[el])) || '';
    if (this.onHover) this.onHover(el);
    this.render();
  }
  bind() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => this.setHover(this.hit(e)));
    c.addEventListener('mouseleave', () => this.setHover(null));
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const el = this.hit(e);
      if (!el || !this.enabled(el)) return;
      e.preventDefault();
      this.pressed = el; this.render();
      const up = (ev) => {
        window.removeEventListener('mouseup', up);
        const was = this.pressed; this.pressed = null; this.render();
        if (was && this.hit(ev) === was) this.onClick(was, ev);
      };
      window.addEventListener('mouseup', up);
    });
  }
  render() {
    const x = this.ctx;
    x.clearRect(0, 0, this.w, this.h);
    if (this.im.normal) x.drawImage(this.im.normal, 0, 0);
    for (const el of Object.keys(this.colours)) {
      let st = null;
      if (!this.enabled(el)) st = this.im.disabled ? 'disabled' : null;
      else if (this.pressed === el) st = 'down';
      else if (this.hover === el && !this.pressed) st = 'hover';
      if (st && this.layers[st + ':' + el]) x.drawImage(this.layers[st + ':' + el], 0, 0);
    }
    if (this.overlay) this.overlay(x, this);
  }
}

/** Draw a glyph so its visible pixels are centred on an element's mapped region. */
function drawCentred(ctx, glyphIm, glyphName, region, dy = 0) {
  const gb = L.glyphs[glyphName];
  const cx = (region[0] + region[2]) / 2, cy = (region[1] + region[3]) / 2;
  ctx.drawImage(glyphIm, Math.round(cx - (gb[0] + gb[2]) / 2), Math.round(cy - (gb[1] + gb[3]) / 2) + dy);
}

const glyph = {};
async function loadGlyphs() {
  const names = Object.keys(L.glyphs);
  const ims = await Promise.all(names.map((n) => loadImg('g_' + n)));
  names.forEach((n, i) => { glyph[n] = ims[i]; });
  for (const n of ['glyph_min', 'glyph_max', 'glyph_restore', 'glyph_close']) glyph[n] = await loadImg(n);
}

// ---------------------------------------------------------------------------------------------
// YouTube player: the real youtube.com watch page in a webview, like a browser. It plays videos
// whose owners block embedded players (most label music videos), shares the Media Guide's sign-in,
// and has the ad blocker applied (see main.js). player-preload.js styles the page from its first
// paint so only the video shows; a black cover hides each load until the video is running.
// ---------------------------------------------------------------------------------------------
let playerState = -1, errorStreak = 0, PATHS = null;
const YTS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const PAGE_POLL = `(() => {
  const p = document.getElementById('movie_player');
  if (!p || !p.getPlayerState) return null;
  const vd = p.getVideoData ? p.getVideoData() : {};
  const e = document.querySelector('.ytp-error');
  const v = p.querySelector('video');
  return { s: p.getPlayerState(), t: p.getCurrentTime(), d: p.getDuration(), title: vd.title, author: vd.author,
    id: vd.video_id, ad: p.classList.contains('ad-showing'), vh: v ? v.clientHeight : 0,
    err: e && e.offsetParent !== null ? (e.innerText || 'This video is unavailable.').trim().split(/\\n/)[0] : null };
})()`;
const page = { wv: null, domReady: false, ready: false, st: {}, lastState: null, pauseOnStart: false, volApplied: false, polling: false, shown: 0 };

function ensurePageView() {
  if (page.wv) return page.wv;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:youtube');
  wv.setAttribute('preload', PATHS.playerPreload);
  wv.setAttribute('webpreferences', 'autoplayPolicy=no-user-gesture-required');
  wv.setAttribute('src', 'about:blank');
  const cover = document.createElement('div');
  cover.id = 'player-cover';
  $('#player-frame').append(wv, cover);
  wv.addEventListener('dom-ready', () => { page.domReady = true; page.navigating = false; });
  page.wv = wv;
  return wv;
}
function setCover(on) { $('#player-frame').classList.toggle('loading', on); }
function pageCall(js) {
  if (!page.wv || !page.domReady) return Promise.resolve();
  return page.wv.executeJavaScript(`(() => { const p = document.getElementById('movie_player'); return p && p.getPlayerState ? p.${js} : undefined; })()`).catch(() => {});
}

function loadIntoPlayer(item, autoplay, start = 0) {
  const wv = ensurePageView();
  // Same video already open (e.g. pre-loaded paused at startup): just seek/play instead of reloading.
  if (page.domReady && page.loadedId === item.id && page.ready && !page.st.err) {
    page.pauseOnStart = !autoplay;
    pageCall(`seekTo(${+start || 0}, true)`);
    if (autoplay) pageCall('playVideo()');
    return;
  }
  const reuse = page.domReady && page.onWatch && page.ready && !page.st.err;
  page.loadedId = item.id;
  Object.assign(page, { st: {}, lastState: null, pauseOnStart: !autoplay, volApplied: false, ccApplied: false, switchedAt: Date.now() });
  setCover(true);
  if (autoplay) setStatus('Opening media…');
  if (reuse) {
    // The watch page is already open: have its player switch videos instead of reloading the
    // whole page (several seconds faster). Its status is ignored until it reports the new video.
    const opts = `{ videoId: '${item.id}', startSeconds: ${Math.floor(+start || 0)} }`;
    pageCall(autoplay ? `loadVideoById(${opts})` : `cueVideoById(${opts})`);
    return;
  }
  page.ready = false;
  page.navigating = true;
  page.onWatch = true;
  const url = `https://www.youtube.com/watch?v=${item.id}` + (start ? `&t=${Math.floor(start)}s` : '');
  const go = () => wv.loadURL(url).catch(() => {});
  page.domReady ? go() : wv.addEventListener('dom-ready', go, { once: true }); // webview API needs its first dom-ready
}

// With nothing queued at startup, open youtube.com in the background so YouTube's player code is
// already cached and connected when the first video is played.
function warmUpPlayer() {
  const wv = ensurePageView();
  const go = () => { page.navigating = true; wv.loadURL('https://www.youtube.com/').catch(() => {}); };
  page.domReady ? go() : wv.addEventListener('dom-ready', go, { once: true });
}

setInterval(async () => {
  if (!page.domReady || !current() || page.polling || page.navigating) return;
  let st;
  page.polling = true;
  try { st = await page.wv.executeJavaScript(PAGE_POLL); } catch { return; } finally { page.polling = false; }
  if (!st) return;
  const item = current();
  if (st.id && st.id !== item.id && Date.now() - (page.switchedAt || 0) < 6000) return;
  page.st = st; page.ready = true;
  if (!page.volApplied) { page.volApplied = true; pageCall(`setVolume(${S.volume})`); pageCall(S.muted ? 'mute()' : 'unMute()'); }
  if (!page.ccApplied && !st.ad) { page.ccApplied = true; applyCaptions(); applyVisualizer(); }
  if (st.err) {
    setCover(false);
    if (page.lastState !== 'err') { page.lastState = 'err'; onPageError(st.err); }
    return;
  }
  // Lift the cover once the video has been laid out at full size for a moment.
  if ((st.s === YTS.PLAYING || st.s === YTS.PAUSED || st.s === YTS.CUED || st.ad) && st.vh > 0) setCover(false);
  if (st.ad) skipAd();
  if (!!st.ad !== app.classList.contains('page-ad')) {
    app.classList.toggle('page-ad', !!st.ad);
    setStatus(st.ad ? 'Skipping advertisement…' : '');
    if (!st.ad) restoreSound(); // skipAd() muted the video element directly
  }
  let s = st.s;
  // YouTube moved on to a video of its own choosing (its autoplay): treat that as the end of ours.
  if (!st.ad && st.id && st.id !== item.id && s === YTS.PLAYING) { pageCall('pauseVideo()'); s = YTS.ENDED; }
  if (s === YTS.PLAYING && !st.ad && page.pauseOnStart) { page.pauseOnStart = false; pageCall('pauseVideo()'); return; }
  if (s === YTS.ENDED && st.ad) return;
  if (s === YTS.PLAYING && statusMsg === 'Opening media…') setStatus('');
  if (s !== page.lastState) { page.lastState = s; onPlayerState(s); }
}, 150);

// Backup for ads that still get through: silence, jump to the end, and press Skip if offered.
const SKIP_AD = `(() => {
  const p = document.getElementById('movie_player');
  if (!p || !p.classList.contains('ad-showing')) return;
  const v = p.querySelector('video');
  const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
  if (skip) skip.click();
  if (v) { v.muted = true; if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration; }
})()`;
function skipAd() { if (page.wv && page.domReady) page.wv.executeJavaScript(SKIP_AD).catch(() => {}); }
function restoreSound() {
  if (!page.wv || !page.domReady) return;
  page.wv.executeJavaScript(`(() => { const v = document.querySelector('#movie_player video'); if (v) v.muted = ${S.muted}; })()`).catch(() => {});
  pageCall(`setVolume(${S.volume})`); pageCall(S.muted ? 'mute()' : 'unMute()');
}

// Captions: the player's captions module is loaded/unloaded per video, and while they're off a
// style rule also hides the caption layer in case YouTube turns them back on mid-video.
const HIDE_CC = '.ytp-caption-window-container { display: none !important; }';
let ccCssKey = null;
async function applyCaptions() {
  if (!page.wv || !page.domReady) return;
  pageCall(S.captions ? "loadModule('captions')" : "unloadModule('captions')");
  if (ccCssKey) { page.wv.removeInsertedCSS(ccCssKey).catch(() => {}); ccCssKey = null; }
  if (!S.captions) ccCssKey = await page.wv.insertCSS(HIDE_CC).catch(() => null);
}
function applyVisualizer() {
  if (page.wv && page.domReady) page.wv.executeJavaScript(`window.__wmpVis && window.__wmpVis.set(${S.visualizer})`).catch(() => {});
}
function toggleVisualizer() {
  S.visualizer = !S.visualizer; save();
  applyVisualizer();
  toast(S.visualizer ? 'Visualizer on' : 'Visualizer off');
}
function toggleCaptions() {
  S.captions = !S.captions; save();
  applyCaptions();
  toast(S.captions ? 'Captions on' : 'Captions off');
}

function onPageError(msg) {
  const item = current();
  setStatus(msg);
  toast(item ? `${item.title || item.id}: ${msg}` : msg);
  errorStreak++;
  if (S.queue.length > 1 && errorStreak < S.queue.length) setTimeout(() => next(true), 1500);
}

/** Player controls (named like YouTube's player API, which the page's player exposes). */
const P = {
  ready() { return page.ready; },
  getCurrentTime() { return page.st.t || 0; },
  getDuration() { return page.st.d || 0; },
  getVideoData() { return { title: page.st.title, author: page.st.author }; },
  seekTo(t) { pageCall(`seekTo(${+t || 0}, true)`); },
  playVideo() { pageCall('playVideo()'); },
  pauseVideo() { pageCall('pauseVideo()'); },
  stopVideo() { pageCall('pauseVideo()'); },
  setVolume(v) { pageCall(`setVolume(${+v})`); },
  mute() { pageCall('mute()'); },
  unMute() { pageCall('unMute()'); },
};

const isPlaying = () => playerState === YTS.PLAYING || playerState === YTS.BUFFERING;

function onPlayerState(st) {
  playerState = st;
  const item = current();
  if (st === YTS.PLAYING) {
    errorStreak = 0;
    if (item) {
      // Fill in metadata the player now knows.
      const vd = P.getVideoData ? P.getVideoData() : {};
      let changed = false;
      if (vd && vd.title && item.title !== vd.title) { item.title = vd.title; changed = true; }
      if (vd && vd.author && item.channel !== vd.author) { item.channel = vd.author; changed = true; }
      const d = P.getDuration();
      if (d && Math.abs((item.dur || 0) - d) > 1) { item.dur = d; changed = true; }
      if (changed) { renderQueue(); renderLibrary(); }
      addHistory(item);
      updateNowPlayingMeta();
    }
  }
  if (st === YTS.ENDED) next(true);
  updatePlayGlyph();
  updateStatus();
  host.setPlaying(isPlaying());
}


// ---------------------------------------------------------------------------------------------
// Queue / transport
// ---------------------------------------------------------------------------------------------
let shuffleSeen = new Set();

function setHasMedia() {
  app.classList.toggle('has-media', S.index >= 0 && !!current());
  requestAnimationFrame(placePlayer);
}

function playIndex(i, { autoplay = true, start = 0 } = {}) {
  if (i < 0 || i >= S.queue.length) return;
  S.index = i; S.position = start;
  shuffleSeen.add(S.queue[i].id);
  loadIntoPlayer(S.queue[i], autoplay, start);
  setHasMedia();
  updateNowPlayingMeta();
  renderQueue(); renderLibrary();
  save();
}

function next(auto = false) {
  if (!S.queue.length) return;
  let i;
  if (S.shuffle && S.queue.length > 1) {
    let pool = S.queue.map((_, k) => k).filter((k) => k !== S.index && !shuffleSeen.has(S.queue[k].id));
    if (!pool.length) {
      if (auto && !S.repeat) { stop(); return; }
      shuffleSeen = new Set([current() && current().id]);
      pool = S.queue.map((_, k) => k).filter((k) => k !== S.index);
    }
    i = pool[Math.floor(Math.random() * pool.length)];
  } else {
    i = S.index + 1;
    if (i >= S.queue.length) {
      if (!S.repeat) { if (auto) stop(); return; }
      i = 0;
    }
  }
  playIndex(i);
}

function prev() {
  if (!S.queue.length) return;
  if (P.ready() && P.getCurrentTime && P.getCurrentTime() > 3) { P.seekTo(0, true); return; }
  let i = S.index - 1;
  if (i < 0) { if (!S.repeat) { if (P.ready()) P.seekTo(0, true); return; } i = S.queue.length - 1; }
  playIndex(i);
}

function togglePlay() {
  if (!current()) { if (S.queue.length) playIndex(0); return; }
  if (!P.ready()) return;
  if (isPlaying()) P.pauseVideo();
  else if (playerState === YTS.CUED || playerState === YTS.UNSTARTED || playerState === YTS.ENDED) P.playVideo();
  else P.playVideo();
}

function stop() {
  if (P.ready()) { P.stopVideo(); P.seekTo(0, false); P.pauseVideo(); }
  S.position = 0; save();
  playerState = YTS.CUED;
  updatePlayGlyph(); updateStatus(); host.setPlaying(false);
}

function setVolume(v) {
  S.volume = Math.max(0, Math.min(100, Math.round(v)));
  if (P.ready()) P.setVolume(S.volume);
  if (S.muted && S.volume > 0) setMuted(false);
  renderVolume(); save();
}
function setMuted(m) {
  S.muted = m;
  if (P.ready()) m ? P.mute() : P.unMute();
  renderVolume(); save();
}

function addItems(items, { playNow = false, at = null } = {}) {
  items = items.filter((it) => it && /^[\w-]{11}$/.test(it.id)).map((it) => ({ id: it.id, title: it.title || '', channel: it.channel || '', dur: it.dur || 0 }));
  if (!items.length) return;
  const pos = at == null ? S.queue.length : at;
  S.queue.splice(pos, 0, ...items);
  if (S.index >= pos && at != null) S.index += items.length;
  items.forEach(lookupMeta);
  if (playNow || S.index < 0) playIndex(pos, { autoplay: playNow || S.index < 0 });
  renderQueue(); renderLibrary(); save();
}

function removeFromQueue(indices) {
  const set = new Set(indices);
  const cur = current();
  const removingCurrent = set.has(S.index);
  S.queue = S.queue.filter((_, i) => !set.has(i));
  if (removingCurrent) {
    S.index = Math.min(S.index, S.queue.length - 1);
    if (S.index >= 0) playIndex(S.index, { autoplay: isPlaying() });
    else { stop(); S.index = -1; setHasMedia(); updateNowPlayingMeta(); }
  } else {
    S.index = cur ? S.queue.indexOf(cur) : -1;
  }
  renderQueue(); renderLibrary(); save();
}

function clearQueue() {
  if (P.ready()) P.stopVideo();
  S.queue = []; S.index = -1; playerState = -1;
  setHasMedia(); updateNowPlayingMeta(); renderQueue(); renderLibrary(); updatePlayGlyph(); updateStatus();
  host.setPlaying(false); save();
}

function addHistory(item) {
  S.history = [{ ...item }, ...S.history.filter((h) => h.id !== item.id)].slice(0, 200);
  if (libSel.kind === 'history') renderLibrary();
  save();
}

// oEmbed lookups (titles for links added without one), a few at a time.
const metaQueue = []; let metaBusy = 0;
function lookupMeta(item) {
  if (item.title && item.channel) return;
  metaQueue.push(item); pumpMeta();
}
function pumpMeta() {
  while (metaBusy < 4 && metaQueue.length) {
    const item = metaQueue.shift(); metaBusy++;
    host.oembed(item.id).then((m) => {
      if (m) {
        for (const list of [S.queue, S.history, ...S.playlists.map((p) => p.items)]) {
          for (const it of list) if (it.id === item.id) { it.title = it.title || m.title; it.channel = it.channel || m.author_name; }
        }
        renderQueue(); renderLibrary(); updateNowPlayingMeta(); save();
      }
    }).finally(() => { metaBusy--; pumpMeta(); });
  }
}

// ---------------------------------------------------------------------------------------------
// Link parsing / adding
// ---------------------------------------------------------------------------------------------
function parseLink(text) {
  text = text.trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text };
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { return null; }
  const hostN = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (hostN === 'youtu.be') id = url.pathname.slice(1, 12);
  else if (hostN === 'youtube.com' || hostN === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else { const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/); if (m) id = m[2]; }
  } else return null;
  const list = url.searchParams.get('list');
  if (id && !/^[\w-]{11}$/.test(id)) id = null;
  if (!id && !list) return null;
  const t = url.searchParams.get('t');
  return { id, list, start: t ? parseInt(t, 10) || 0 : 0 };
}

async function handleInput(text, { playNow = true } = {}) {
  const links = text.split(/[\s,]+/).map(parseLink).filter(Boolean);
  if (!links.length) {
    if (text.trim()) searchYouTube(text.trim());
    return;
  }
  if (links.length === 1 && links[0].list) { await importPlaylist(links[0].list, links[0].id, playNow); return; }
  const items = links.filter((l) => l.id).map((l) => ({ id: l.id }));
  addItems(items, { playNow });
  if (playNow) showView('nowplaying');
  toast(items.length === 1 ? 'Added to Now Playing' : `Added ${items.length} videos to Now Playing`);
}

// Playlists are read from youtube.com itself in a hidden webview (same sign-in as Media Guide, so
// private lists, Liked videos and Watch Later work when signed in). Normal playlists come from the
// /playlist page, scrolled until every row has loaded; Mixes (RD…) from the watch page's queue.
// Builds an in-page script that collects the videos under `root` (an expression evaluated in the
// youtube.com page). Handles both YouTube's older renderers and its newer "lockup" view models.
// With follow=true it keeps requesting the list's continuation pages, exactly as the page does
// when you scroll, so playlists longer than the first 100 load completely.
const readPlaylistScript = (root, follow) => `(async () => {
  const DUR = /^\\d+(:\\d+)+$/;
  const secs = (t) => (DUR.test(t || '') ? t.split(':').reduce((a, n) => a * 60 + +n, 0) : 0);
  const findText = (o, test) => {
    let r = null;
    const w = (x, d) => {
      if (r || !x || typeof x !== 'object' || d > 30) return;
      if (Array.isArray(x)) { x.forEach((y) => w(y, d + 1)); return; }
      for (const k in x) { const v = x[k]; if (typeof v === 'string' && test(k, v)) { r = v; return; } w(v, d + 1); }
    };
    w(o, 0);
    return r;
  };
  const out = [], seen = new Set();
  let token = null;
  const add = (id, title, channel, dur) => { if (id && !seen.has(id)) { seen.add(id); out.push({ id, title: title || '', channel: channel || '', dur: dur || 0 }); } };
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 60) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
    const pv = o.playlistVideoRenderer || o.playlistPanelVideoRenderer;
    if (pv && pv.videoId) {
      add(pv.videoId, (pv.title && (pv.title.simpleText || (pv.title.runs || [])[0]?.text)),
        ((pv.shortBylineText || {}).runs || [])[0]?.text,
        +pv.lengthSeconds || secs(pv.lengthText && pv.lengthText.simpleText));
      return;
    }
    const lv = o.lockupViewModel;
    if (lv && lv.contentId && (!lv.contentType || /VIDEO/.test(lv.contentType))) {
      const md = (lv.metadata || {}).lockupMetadataViewModel || {};
      const rows = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
      add(lv.contentId, (md.title || {}).content, ((rows[0] || {}).metadataParts || [])[0]?.text?.content,
        secs(findText(lv.contentImage, (k, v) => k === 'text' && DUR.test(v))));
      return;
    }
    const ci = o.continuationItemRenderer;
    if (ci) { const t = findText(ci, (k) => k === 'token'); if (t) token = t; return; }
    for (const k in o) walk(o[k], d + 1);
  };
  walk(${root}, 0);
  for (let n = 0; ${follow} && token && n < 60; n++) {
    const t = token; token = null;
    const r = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), continuation: t }),
    }).catch(() => null);
    if (!r || !r.ok) break;
    walk(await r.json(), 0);
  }
  return out;
})()`;
const READ_LIST = readPlaylistScript('window.ytInitialData', true);
const READ_MIX = readPlaylistScript('(((window.ytInitialData || {}).contents || {}).twoColumnWatchNextResults || {}).playlist', false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPlaylist(listId, startId) {
  const mix = /^RD/.test(listId);
  if (mix && !startId) return [];
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:youtube');
  wv.setAttribute('src', mix ? `https://www.youtube.com/watch?v=${startId}&list=${listId}` : `https://www.youtube.com/playlist?list=${listId}`);
  $('#yt-helper').appendChild(wv);
  try {
    await Promise.race([new Promise((r) => wv.addEventListener('did-finish-load', r, { once: true })), sleep(15000)]);
    for (let i = 0; i < 10; i++) {
      const rows = await wv.executeJavaScript(mix ? READ_MIX : READ_LIST).catch(() => []);
      if (rows && rows.length) return rows;
      await sleep(400);
    }
    return [];
  } finally {
    wv.remove();
  }
}

/** Load a YouTube playlist. replace: make it the Now Playing list (like opening a playlist in WMP). */
async function importPlaylist(listId, startId, playNow = true, { replace = playNow } = {}) {
  toast('Loading playlist…');
  // The link names a song: start it right away and fill in the rest of the list while it loads.
  const early = replace && playNow && !!startId;
  if (early) {
    if (P.ready()) P.stopVideo();
    S.queue = [{ id: startId, title: '', channel: '', dur: 0 }]; S.index = -1; shuffleSeen.clear(); lpSel.clear();
    lookupMeta(S.queue[0]);
    playIndex(0); showView('nowplaying');
  }
  setStatus('Loading playlist…');
  const rows = await readPlaylist(listId, startId);
  setStatus('');
  if (!rows.length) {
    if (early) toast("Couldn't read that playlist — playing the single video instead.");
    else if (startId) { addItems([{ id: startId }], { playNow }); toast("Couldn't read that playlist — added the single video instead."); }
    else toast("Couldn't read that playlist. It may be private (sign in on the Media Guide tab).");
    return;
  }
  const start = startId ? Math.max(0, rows.findIndex((r) => r.id === startId)) : 0;
  if (early && current() && current().id === startId) {
    // Swap in the full list around the song that is already playing; no reload.
    const playing = current();
    S.queue = rows.map((r) => (r.id === startId ? Object.assign(playing, { title: playing.title || r.title, channel: playing.channel || r.channel, dur: playing.dur || r.dur }) : { id: r.id, title: r.title, channel: r.channel, dur: r.dur }));
    S.index = start;
    if (!S.listPane) toggleListPane();
    renderQueue(); renderLibrary(); updateNowPlayingMeta(); save();
    toast(`Loaded ${rows.length} videos from the playlist`);
    return;
  }
  if (replace) {
    if (P.ready()) P.stopVideo();
    S.queue = []; S.index = -1; shuffleSeen.clear(); lpSel.clear();
  }
  const at = S.queue.length;
  S.queue.push(...rows.map((r) => ({ id: r.id, title: r.title, channel: r.channel, dur: r.dur })));
  rows.forEach(lookupMeta);
  if (!S.listPane) toggleListPane();
  if (playNow) { playIndex(at + start); showView('nowplaying'); }
  renderQueue(); renderLibrary(); save();
  toast(`${replace ? 'Loaded' : 'Added'} ${rows.length} videos from the playlist`);
}

// ---------------------------------------------------------------------------------------------
// Transport UI
// ---------------------------------------------------------------------------------------------
let capBtns, navBtns, tgroup, btnShuffle, btnRepeat, btnMute, btnSplit;

async function buildSkin() {
  L = await (await fetch('skin/layout.json')).json();
  await loadGlyphs();
  const R = L.regions;

  capBtns = await new RegionalButton($('#capbtns'), {
    images: { hover: 'cap_hover', down: 'cap_down' }, map: 'cap_map',
    tip: { min: 'Minimize', max: () => (winState.maximized ? 'Restore Down' : 'Maximize'), close: 'Close' },
    overlay: (x) => {
      x.drawImage(glyph.glyph_min, 0, 0);
      x.drawImage(winState.maximized ? glyph.glyph_restore : glyph.glyph_max, 27, 0);
      x.drawImage(glyph.glyph_close, 50, 0);
    },
    onClick: (el) => host.win(el),
  }).init();

  navBtns = await new RegionalButton($('#navbtns'), {
    images: { normal: 'nav', hover: 'nav_hover', down: 'nav_down', disabled: 'nav_disabled' }, map: 'nav_map',
    tip: { back: 'Back', forward: 'Forward' },
    enabled: (el) => (el === 'back' ? canGoBack() : canGoForward()),
    onClick: (el) => (el === 'back' ? goBack() : goForward()),
  }).init();

  const glowEl = $('#play-glow');
  tgroup = await new RegionalButton($('#tgroup'), {
    images: { normal: 'tgroup', hover: 'tgroup_hover', down: 'tgroup_down', disabled: 'tgroup_disabled' }, map: 'tgroup_map',
    tip: { stop: 'Stop', prev: 'Previous', play: () => (isPlaying() ? 'Pause' : 'Play'), next: 'Next' },
    enabled: (el) => el === 'play' || (S.queue.length > 0 && (el !== 'stop' || current())),
    overlay: (x, b) => {
      const R2 = R.tgroup_map, dy = (el) => (b.pressed === el ? 1 : 0);
      drawCentred(x, glyph.stop, 'stop', R2.stop, dy('stop'));
      drawCentred(x, glyph.prev, 'prev', R2.prev, dy('prev'));
      drawCentred(x, glyph.next, 'next', R2.next, dy('next'));
      const pg = isPlaying() ? 'pause' : (S.queue.length ? 'play' : 'play_disabled');
      drawCentred(x, glyph[pg], pg, R2.play, dy('play'));
    },
    onHover: (el) => glowEl.classList.toggle('on', el === 'play'),
    onClick: (el) => ({ stop, prev, next: () => next(false), play: togglePlay })[el](),
  }).init();
  // Centre the glow ring on the play orb.
  const pr = R.tgroup_map.play, gw = L.sizes.glow;
  const placeGlow = () => {
    const base = app.classList.contains('small-transport') ? 29 : 94;
    glowEl.style.left = Math.round(base + (pr[0] + pr[2]) / 2 - gw[0] / 2) + 'px';
    glowEl.style.top = Math.round(1 + (pr[1] + pr[3]) / 2 - gw[1] / 2) + 'px';
  };
  placeGlow(); new MutationObserver(placeGlow).observe(app, { attributes: true, attributeFilter: ['class'] });

  const roundBtn = (el, glyphFn, onClick, tip) => new RegionalButton(el, {
    images: { normal: 'round', hover: 'round_hover', down: 'round_down' }, map: 'round_map', tip: { btn: tip },
    overlay: (x) => x.drawImage(glyph[glyphFn()], 0, 0),
    onClick,
  }).init();
  btnShuffle = await roundBtn($('#btn-shuffle'), () => (S.shuffle ? 'shuffle_on' : 'shuffle_off'), toggleShuffle, () => (S.shuffle ? 'Turn shuffle off (Ctrl+H)' : 'Turn shuffle on (Ctrl+H)'));
  btnRepeat = await roundBtn($('#btn-repeat'), () => (S.repeat ? 'repeat_on' : 'repeat_off'), toggleRepeat, () => (S.repeat ? 'Turn repeat off (Ctrl+T)' : 'Turn repeat on (Ctrl+T)'));
  const muteGlyph = () => (S.muted ? 'mute' : S.volume === 0 ? 'vol0' : S.volume < 33 ? 'vol1' : S.volume < 66 ? 'vol2' : 'vol3');
  btnMute = await roundBtn($('#btn-mute'), muteGlyph, () => setMuted(!S.muted), () => (S.muted ? 'Sound' : 'Mute (F7)'));
  // Compact mode: left part mutes, right arrow pops up a volume slider.
  btnSplit = await new RegionalButton($('#btn-split'), {
    images: { normal: 'split', hover: 'split_hover', down: 'split_down' }, map: 'split_map',
    tip: { mute: () => (S.muted ? 'Sound' : 'Mute (F7)'), popup: 'Volume' },
    overlay: (x) => x.drawImage(glyph[muteGlyph()], 0, 0),
    onClick: (el) => (el === 'mute' ? setMuted(!S.muted) : toggleVolumePopup()),
  }).init();
}

function toggleVolumePopup(force) {
  const pop = $('#volpop'), open = force != null ? force : !pop.classList.contains('open');
  if (open) {
    // WMP11 PopupSlider(): just left of and below the split button.
    pop.style.left = $('#transport').offsetLeft + 218 - 15 + 'px';
    pop.style.top = 14 + 5 + 'px';
  }
  pop.classList.toggle('open', open);
}

function toggleShuffle() { S.shuffle = !S.shuffle; shuffleSeen = new Set(current() ? [current().id] : []); btnShuffle.render(); toast(S.shuffle ? 'Shuffle on' : 'Shuffle off'); save(); }
function toggleRepeat() { S.repeat = !S.repeat; btnRepeat.render(); toast(S.repeat ? 'Repeat on' : 'Repeat off'); save(); }
function updatePlayGlyph() { if (tgroup) tgroup.render(); }

function renderVolume() {
  const x = 6 + (S.volume / 100) * (78 - 12) + 'px';
  $('#vol-thumb').style.left = x;
  $('#vol-thumb2').style.left = x;
  if (btnMute) { btnMute.render(); btnSplit.render(); }
}

function makeSlider(el, { onDrag, onCommit, thumb, images }) {
  let dragging = false;
  const frac = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true; thumb.src = `skin/${images.down}.png`;
    onDrag(frac(e));
    const move = (ev) => onDrag(frac(ev));
    const up = (ev) => {
      dragging = false; thumb.src = `skin/${images.normal}.png`;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      onCommit(frac(ev));
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  el.addEventListener('mouseenter', () => { if (!dragging) thumb.src = `skin/${images.hover}.png`; });
  el.addEventListener('mouseleave', () => { if (!dragging) thumb.src = `skin/${images.normal}.png`; });
  return { get dragging() { return dragging; } };
}

let seekSlider;
let seekF = 0;
function setSeekVisual(f) {
  seekF = f;
  const seek = $('#seek'), thumb = $('#seek-thumb'), w = seek.clientWidth;
  const tw = thumb.naturalWidth || 20, th = thumb.naturalHeight || 10;
  // Keep the whole thumb inside the bar (as WMP does) and centre it vertically; the normal and
  // hover thumb images are different sizes, so this is recomputed whenever the image changes.
  const x = Math.round(Math.min(w - tw, Math.max(0, f * w - tw / 2)));
  thumb.style.left = x + 'px';
  thumb.style.top = Math.round((seek.clientHeight - th) / 2) + 'px';
  $('#seek-fill').style.width = Math.max(36, x + tw / 2 + 2) + 'px';
  seek.classList.toggle('zero', f * w < 2);
}
$('#seek-thumb').addEventListener('load', () => setSeekVisual(seekF));
function setupSliders() {
  seekSlider = makeSlider($('#seek'), {
    thumb: $('#seek-thumb'), images: { normal: 'seek_thumb', hover: 'seek_thumb_hover', down: 'seek_thumb_down' },
    onDrag: (f) => {
      setSeekVisual(f);
      const d = P.ready() ? P.getDuration() : 0;
      if (d) $('#mq-time').textContent = fmtTime(f * d);
    },
    onCommit: (f) => { const d = P.ready() ? P.getDuration() : 0; if (d) P.seekTo(f * d, true); },
  });
  makeSlider($('#volume'), {
    thumb: $('#vol-thumb'), images: { normal: 'vol_thumb', hover: 'vol_thumb_hover', down: 'vol_thumb_down' },
    onDrag: (f) => setVolume(f * 100), onCommit: (f) => setVolume(f * 100),
  });
  makeSlider($('#volume2'), {
    thumb: $('#vol-thumb2'), images: { normal: 'vol_thumb', hover: 'vol_thumb_hover', down: 'vol_thumb_down' },
    onDrag: (f) => setVolume(f * 100), onCommit: (f) => { setVolume(f * 100); toggleVolumePopup(false); },
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#volpop, #btn-split')) toggleVolumePopup(false);
  });
  for (const el of [$('#volume'), $('#btn-mute'), $('#btn-split'), $('#volpop')]) {
    el.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(S.volume + (e.deltaY < 0 ? 5 : -5)); }, { passive: false });
  }
  renderVolume();
}

// Periodic UI update (seek bar, time).
setInterval(() => {
  if (!P.ready() || !current()) { $('#mq-time').textContent = ''; $('#caption-time').textContent = ''; return; }
  const t = P.getCurrentTime() || 0, d = P.getDuration() || current().dur || 0;
  if (!seekSlider.dragging) {
    setSeekVisual(d ? t / d : 0);
    const label = S.timeMode === 'remaining' && d ? '-' + fmtTime(d - t) : fmtTime(t);
    $('#mq-time').textContent = d ? label : '';
  }
  $('#caption-time').textContent = app.classList.contains('narrow') && d ? fmtTime(t) : '';
  if (Math.abs(t - S.position) >= 5) { S.position = t; save(); }
}, 250);

$('#mq-time').addEventListener('click', () => { S.timeMode = S.timeMode === 'elapsed' ? 'remaining' : 'elapsed'; save(); });

// ---------------------------------------------------------------------------------------------
// Status / metadata
// ---------------------------------------------------------------------------------------------
let statusMsg = '';
function setStatus(msg) { statusMsg = msg; updateStatus(); }
function updateStatus() {
  const item = current();
  const st = { [YTS.PLAYING]: 'Playing', [YTS.PAUSED]: 'Paused', [YTS.BUFFERING]: 'Buffering', [YTS.ENDED]: 'Stopped', [YTS.CUED]: 'Ready' }[playerState] || (item ? 'Ready' : '');
  $('#mq-line1').textContent = item ? (item.title || 'Loading…') : '';
  $('#mq-line2').textContent = item ? [st, item.channel].filter(Boolean).join(' · ') : '';
  $('#status-text').textContent = statusMsg;
}
function updateNowPlayingMeta() {
  const item = current();
  $('#lp-title').textContent = item ? item.title || 'Loading…' : 'Now Playing list is empty';
  $('#lp-channel').textContent = item ? item.channel || '' : '';
  $('#dock-title').textContent = item ? item.title || '' : '';
  const art = item ? thumb(item.id) : null;
  for (const img of [$('#lp-art-img'), $('#mq-art')]) { if (art) img.src = art; else img.removeAttribute('src'); }
  host.setTitle(item && item.title ? `${item.title} - Windows Media Player` : 'Windows Media Player');
  updateStatus();
}

// ---------------------------------------------------------------------------------------------
// Now Playing list pane
// ---------------------------------------------------------------------------------------------
let lpSel = new Set();
function renderQueue() {
  const ol = $('#lp-list');
  ol.innerHTML = '';
  S.queue.forEach((it, i) => {
    const li = document.createElement('li');
    li.dataset.i = i; li.draggable = true;
    li.className = (i === S.index ? 'current ' : '') + (lpSel.has(i) ? 'sel' : '');
    li.innerHTML = '<span class="t-title"></span><span class="t-len"></span>';
    li.firstChild.textContent = it.title || it.id;
    li.title = [it.title, it.channel].filter(Boolean).join('\n');
    li.lastChild.textContent = it.dur ? fmtTime(it.dur) : '';
    ol.appendChild(li);
  });
  const total = S.queue.reduce((a, it) => a + (it.dur || 0), 0);
  $('#lp-foot').textContent = S.queue.length ? `${S.queue.length} item${S.queue.length > 1 ? 's' : ''}${total ? ', ' + fmtTime(total) : ''}` : '';
  if (tgroup) tgroup.render();
}

function listSelection(ol, set, e, i) {
  if (e.ctrlKey) set.has(i) ? set.delete(i) : set.add(i);
  else if (e.shiftKey && set.size) {
    const anchor = Math.min(...set); set.clear();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) set.add(k);
  } else if (!(e.button === 2 && set.has(i))) { set.clear(); set.add(i); }
}

const lpList = $('#lp-list');
// Double-click a row to play it. Selecting redraws the list on every mousedown, so the browser's own
// dblclick never reaches the row; two presses on the same row in quick succession are detected instead.
let lpPress = null;
lpList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const i = +li.dataset.i, now = Date.now();
  const plain = e.button === 0 && !e.ctrlKey && !e.shiftKey;
  const double = plain && lpPress && lpPress.i === i && now - lpPress.t < 500;
  lpPress = plain && !double ? { i, t: now } : null;
  listSelection(lpList, lpSel, e, i); renderQueue();
  if (double) { if (i !== S.index) playIndex(i); else if (!isPlaying()) togglePlay(); }
});
lpList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  e.preventDefault();
  const idx = [...lpSel].sort((a, b) => a - b), items = idx.map((i) => S.queue[i]);
  showMenu(e.clientX, e.clientY, [
    { label: 'Play', action: () => playIndex(idx[0]) },
    { label: 'Play next', action: () => moveQueueItems(idx, S.index + 1) },
    ...playlistTargets(items),
    '-',
    { label: 'Remove from list', action: () => { removeFromQueue(idx); lpSel.clear(); } },
    { label: 'Open on YouTube', action: () => host.openExternal(ytUrl(items[0].id)) },
    { label: 'Copy link', action: () => navigator.clipboard.writeText(items.map((it) => ytUrl(it.id)).join('\n')) },
  ]);
});
setupReorder(lpList, (from, to) => moveQueueItems(from, to));

function moveQueueItems(indices, to) {
  const cur = current();
  const set = new Set(indices);
  const moving = S.queue.filter((_, i) => set.has(i));
  const before = indices.filter((i) => i < to).length;
  S.queue = S.queue.filter((_, i) => !set.has(i));
  const at = Math.max(0, Math.min(S.queue.length, to - before));
  S.queue.splice(at, 0, ...moving);
  S.index = cur ? S.queue.indexOf(cur) : -1;
  lpSel = new Set(moving.map((_, k) => at + k));
  renderQueue(); renderLibrary(); save();
}

/** Drag-reorder within a list of <li data-i>. Also lets items be dragged onto playlists in the nav pane. */
let dragPayload = null;
function setupReorder(ol, onMove, getItems) {
  ol.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    const sel = ol === lpList ? lpSel : libSelRows;
    if (!sel.has(+li.dataset.i)) { sel.clear(); sel.add(+li.dataset.i); }
    const idx = [...sel].sort((a, b) => a - b);
    const list = getItems ? getItems() : S.queue;
    dragPayload = { source: ol, indices: idx, items: idx.map((i) => list[i]) };
    e.dataTransfer.setData('text/plain', dragPayload.items.map((it) => ytUrl(it.id)).join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  ol.addEventListener('dragover', (e) => {
    if (!dragPayload || dragPayload.source !== ol || !onMove) return;
    e.preventDefault();
    $$('.drop-above,.drop-below', ol).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    const li = e.target.closest('li'); if (!li) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  ol.addEventListener('drop', (e) => {
    if (!dragPayload || dragPayload.source !== ol || !onMove) return;
    e.preventDefault(); e.stopPropagation();
    const li = e.target.closest('li');
    let to = li ? +li.dataset.i + (li.classList.contains('drop-below') ? 1 : 0) : ol.children.length;
    $$('.drop-above,.drop-below', ol).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    onMove(dragPayload.indices, to);
    dragPayload = null;
  });
  ol.addEventListener('dragend', () => { dragPayload = null; $$('.drop-above,.drop-below,.drop-target').forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-target')); });
}

$('#lp-clear').addEventListener('click', clearQueue);
$('#lp-save').addEventListener('click', saveQueueAsPlaylist);
async function saveQueueAsPlaylist() {
  if (!S.queue.length) { toast('The Now Playing list is empty.'); return; }
  const name = await promptName('Save Now Playing list as', uniqueName('Playlist'));
  if (!name) return;
  S.playlists.push({ name, items: S.queue.map((it) => ({ ...it })) });
  renderNav(); save(); toast(`Saved "${name}"`);
}

// ---------------------------------------------------------------------------------------------
// Library view
// ---------------------------------------------------------------------------------------------
let libSel = { kind: 'queue' };
let libSelRows = new Set();
function libItems() {
  if (libSel.kind === 'queue') return S.queue;
  if (libSel.kind === 'history') return S.history;
  const p = S.playlists.find((x) => x.name === libSel.name);
  return p ? p.items : [];
}
function uniqueName(base) {
  let n = 1, name = base;
  while (S.playlists.some((p) => p.name === name)) name = `${base} ${++n}`;
  return name;
}
function renderNav() {
  const box = $('#nav-playlists');
  box.innerHTML = '';
  for (const p of S.playlists) {
    const d = document.createElement('div');
    d.className = 'nav-item'; d.dataset.lib = 'playlist'; d.dataset.name = p.name; d.textContent = p.name;
    box.appendChild(d);
  }
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.lib === libSel.kind && (libSel.kind !== 'playlist' || n.dataset.name === libSel.name)));
}
function renderLibrary() {
  if (!app.classList.contains('view-library')) return;
  const items = libItems();
  const title = libSel.kind === 'queue' ? 'Now Playing' : libSel.kind === 'history' ? 'Recently Played' : libSel.name;
  $('#lib-title').textContent = title;
  $('#lib-actions [data-act=rename]').hidden = $('#lib-actions [data-act=delete]').hidden = libSel.kind !== 'playlist';
  $('#lib-actions [data-act=enqueue]').hidden = libSel.kind === 'queue';
  const ol = $('#lib-list');
  ol.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.dataset.i = i; li.draggable = true;
    li.className = (libSelRows.has(i) ? 'sel ' : '') + (libSel.kind === 'queue' && i === S.index ? 'current' : '');
    li.innerHTML = '<span class="c-num"></span><span class="c-title"></span><span class="c-chan"></span><span class="c-len"></span>';
    li.children[0].textContent = i + 1;
    li.children[1].textContent = it.title || it.id;
    li.children[2].textContent = it.channel || '';
    li.children[3].textContent = it.dur ? fmtTime(it.dur) : '';
    ol.appendChild(li);
  });
  const empty = $('#lib-empty');
  empty.textContent = libSel.kind === 'history' ? 'Videos you play will appear here.' : libSel.kind === 'queue' ? 'The Now Playing list is empty.' : 'This playlist is empty. Drag videos here or right-click a video and choose "Add to".';
  empty.classList.toggle('show', !items.length);
  renderNav();
}
$('#navpane').addEventListener('click', (e) => {
  const n = e.target.closest('.nav-item'); if (!n) return;
  libSel = n.dataset.lib === 'playlist' ? { kind: 'playlist', name: n.dataset.name } : { kind: n.dataset.lib };
  libSelRows.clear(); renderLibrary();
});
$('#navpane').addEventListener('contextmenu', (e) => {
  const n = e.target.closest('.nav-item[data-lib=playlist]'); if (!n) return;
  e.preventDefault();
  const name = n.dataset.name;
  showMenu(e.clientX, e.clientY, [
    { label: 'Play', action: () => playList(S.playlists.find((p) => p.name === name).items) },
    { label: 'Add to Now Playing', action: () => addItems(S.playlists.find((p) => p.name === name).items) },
    '-',
    { label: 'Rename', action: () => renamePlaylist(name) },
    { label: 'Delete', action: () => deletePlaylist(name) },
  ]);
});
// Drop videos onto a playlist in the nav pane.
$('#navpane').addEventListener('dragover', (e) => {
  const n = e.target.closest('.nav-item[data-lib=playlist]');
  $$('.nav-item.drop-target').forEach((x) => x !== n && x.classList.remove('drop-target'));
  if (!n || !dragPayload) return;
  e.preventDefault(); n.classList.add('drop-target');
});
$('#navpane').addEventListener('drop', (e) => {
  const n = e.target.closest('.nav-item[data-lib=playlist]');
  if (!n || !dragPayload) return;
  e.preventDefault(); e.stopPropagation(); n.classList.remove('drop-target');
  addToPlaylist(n.dataset.name, dragPayload.items);
  dragPayload = null;
});
$('#new-playlist').addEventListener('click', async (e) => {
  e.stopPropagation();
  const name = await promptName('New playlist name', uniqueName('New Playlist'));
  if (!name) return;
  S.playlists.push({ name, items: [] });
  libSel = { kind: 'playlist', name }; showView('library'); save();
});

function playList(items) {
  if (!items.length) return;
  S.queue = items.map((it) => ({ ...it })); S.index = -1; shuffleSeen.clear();
  playIndex(S.shuffle ? Math.floor(Math.random() * items.length) : 0);
}
function addToPlaylist(name, items) {
  const p = S.playlists.find((x) => x.name === name); if (!p) return;
  p.items.push(...items.map((it) => ({ ...it })));
  renderLibrary(); save(); toast(`Added ${items.length} to "${name}"`);
}
async function renamePlaylist(name) {
  const p = S.playlists.find((x) => x.name === name); if (!p) return;
  const nn = await promptName('Rename playlist', name);
  if (!nn || nn === name) return;
  if (S.playlists.some((x) => x.name === nn)) { toast('A playlist with that name already exists.'); return; }
  p.name = nn; if (libSel.name === name) libSel.name = nn;
  renderLibrary(); renderNav(); save();
}
function deletePlaylist(name) {
  S.playlists = S.playlists.filter((x) => x.name !== name);
  if (libSel.name === name) libSel = { kind: 'queue' };
  renderLibrary(); renderNav(); save();
}
function playlistTargets(items) {
  const t = [{ label: 'Add to new playlist…', action: async () => {
    const name = await promptName('New playlist name', uniqueName('New Playlist'));
    if (name) { S.playlists.push({ name, items: [] }); addToPlaylist(name, items); renderNav(); }
  } }];
  for (const p of S.playlists) t.push({ label: `Add to "${p.name}"`, action: () => addToPlaylist(p.name, items) });
  return t;
}

$('#lib-actions').addEventListener('click', (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const items = libItems();
  if (act === 'play') { if (libSel.kind === 'queue') { if (S.queue.length) playIndex(0); } else playList(items); showView('nowplaying'); }
  else if (act === 'enqueue') addItems(items);
  else if (act === 'rename') renamePlaylist(libSel.name);
  else if (act === 'delete') deletePlaylist(libSel.name);
});

const libList = $('#lib-list');
libList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  listSelection(libList, libSelRows, e, +li.dataset.i); renderLibrary();
});
libList.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const i = +li.dataset.i;
  if (libSel.kind === 'queue') playIndex(i);
  else { addItems([libItems()[i]], { playNow: true }); }
});
libList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  e.preventDefault();
  const idx = [...libSelRows].sort((a, b) => a - b), items = idx.map((i) => libItems()[i]);
  const menu = [
    { label: 'Play', action: () => (libSel.kind === 'queue' ? playIndex(idx[0]) : addItems(items, { playNow: true })) },
  ];
  if (libSel.kind !== 'queue') {
    menu.push({ label: 'Play next', action: () => addItems(items, { at: S.index + 1 }) });
    menu.push({ label: 'Add to Now Playing', action: () => addItems(items) });
  }
  menu.push(...playlistTargets(items), '-');
  menu.push({ label: libSel.kind === 'history' ? 'Remove from history' : 'Remove from list', action: () => removeLibRows(idx) });
  menu.push({ label: 'Open on YouTube', action: () => host.openExternal(ytUrl(items[0].id)) });
  menu.push({ label: 'Copy link', action: () => navigator.clipboard.writeText(items.map((it) => ytUrl(it.id)).join('\n')) });
  showMenu(e.clientX, e.clientY, menu);
});
setupReorder(libList, (from, to) => {
  if (libSel.kind === 'queue') { moveQueueItems(from, to); return; }
  if (libSel.kind !== 'playlist') return;
  const list = libItems(), set = new Set(from);
  const moving = list.filter((_, i) => set.has(i)), before = from.filter((i) => i < to).length;
  const rest = list.filter((_, i) => !set.has(i));
  rest.splice(Math.max(0, to - before), 0, ...moving);
  list.length = 0; list.push(...rest);
  libSelRows.clear(); renderLibrary(); save();
}, libItems);

function removeLibRows(idx) {
  if (libSel.kind === 'queue') removeFromQueue(idx);
  else {
    const set = new Set(idx), list = libItems(), keep = list.filter((_, i) => !set.has(i));
    list.length = 0; list.push(...keep);
  }
  libSelRows.clear(); renderLibrary(); save();
}

// ---------------------------------------------------------------------------------------------
// Media Guide (youtube.com in a webview)
// ---------------------------------------------------------------------------------------------
let webview = null, guideReady = null;
async function ensureGuide() {
  if (webview) return webview;
  const { webviewPreload } = await host.paths();
  webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:youtube');
  webview.setAttribute('preload', webviewPreload);
  webview.setAttribute('src', 'https://www.youtube.com/');
  guideReady = new Promise((res) => webview.addEventListener('dom-ready', res, { once: true }));
  $('#guide-host').appendChild(webview);
  webview.addEventListener('ipc-message', (e) => {
    const v = e.args[0];
    if (e.channel === 'yt-pick') {
      if (v.list && !v.id) importPlaylist(v.list, null, true);
      else { addItems([{ id: v.id, title: v.title }], { playNow: true }); }
    } else if (e.channel === 'yt-menu') {
      const r = webview.getBoundingClientRect();
      const item = { id: v.id, title: v.title };
      const menu = v.id ? [
        { label: 'Play now', action: () => addItems([item], { playNow: true }) },
        { label: 'Play next', action: () => addItems([item], { at: S.index + 1 }) },
        { label: 'Add to Now Playing', action: () => addItems([item]) },
        ...playlistTargets([item]),
      ] : [];
      if (v.list) menu.push('-', { label: 'Add whole playlist to Now Playing', action: () => importPlaylist(v.list, null, false, { replace: false }) });
      showMenu(r.left + v.x, r.top + v.y, menu);
    }
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page']) webview.addEventListener(ev, () => navBtns && navBtns.render());
  return webview;
}
async function guideNav(url) {
  await showView('guide');
  await guideReady;
  webview.loadURL(url);
}
function searchYouTube(q) { return guideNav('https://www.youtube.com/results?search_query=' + encodeURIComponent(q)); }

// ---------------------------------------------------------------------------------------------
// Views + navigation history
// ---------------------------------------------------------------------------------------------
let view = 'nowplaying';
const viewHist = ['nowplaying']; let viewPos = 0;
async function showView(v, { fromHistory = false } = {}) {
  if (v === 'guide') await ensureGuide();
  view = v;
  app.classList.remove('view-nowplaying', 'view-library', 'view-guide');
  app.classList.add('view-' + v);
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  if (!fromHistory && viewHist[viewPos] !== v) { viewHist.splice(viewPos + 1); viewHist.push(v); viewPos = viewHist.length - 1; }
  if (v === 'library') renderLibrary();
  if (navBtns) navBtns.render();
  requestAnimationFrame(placePlayer);
}
const inGuide = () => view === 'guide' && webview;
// webview navigation methods throw until its first dom-ready
const wvCan = (fn) => { try { return inGuide() && webview[fn](); } catch { return false; } };
function canGoBack() { return wvCan('canGoBack') || viewPos > 0; }
function canGoForward() { return wvCan('canGoForward') || viewPos < viewHist.length - 1; }
function goBack() {
  if (wvCan('canGoBack')) { webview.goBack(); return; }
  if (viewPos > 0) showView(viewHist[--viewPos], { fromHistory: true });
}
function goForward() {
  if (wvCan('canGoForward')) { webview.goForward(); return; }
  if (viewPos < viewHist.length - 1) showView(viewHist[++viewPos], { fromHistory: true });
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  if (e.target.classList.contains('tab-drop')) { tabMenu(tab); return; }
  showView(tab.dataset.view);
});
function tabMenu(tab) {
  const r = tab.getBoundingClientRect(), x = r.left, y = r.bottom;
  const v = tab.dataset.view;
  if (v === 'nowplaying') {
    showMenu(x, y, [
      { label: 'Show List Pane', checked: S.listPane, action: toggleListPane },
      { label: 'Visualizer', checked: S.visualizer, action: toggleVisualizer },
      { label: 'Captions', checked: S.captions, action: toggleCaptions },
      { label: 'Full Screen', action: () => host.win('fullscreen') },
      '-',
      { label: 'Save List As…', action: saveQueueAsPlaylist },
      { label: 'Clear List', action: clearQueue },
    ]);
  } else if (v === 'library') {
    const go = (sel) => () => { libSel = sel; libSelRows.clear(); showView('library'); };
    showMenu(x, y, [
      { label: 'Now Playing', action: go({ kind: 'queue' }) },
      { label: 'Recently Played', action: go({ kind: 'history' }) },
      ...(S.playlists.length ? ['-'] : []),
      ...S.playlists.map((p) => ({ label: p.name, action: go({ kind: 'playlist', name: p.name }) })),
      '-',
      { label: 'Create Playlist…', action: () => $('#new-playlist').click() },
    ]);
  } else {
    const nav = (path) => () => guideNav('https://www.youtube.com' + path);
    showMenu(x, y, [
      { label: 'YouTube Home', action: nav('/') },
      { label: 'Subscriptions', action: nav('/feed/subscriptions') },
      { label: 'Your Library', action: nav('/feed/you') },
      { label: 'Music', action: nav('/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ') },
      '-',
      { label: 'Reload', action: async () => { await showView('guide'); await guideReady; webview.reload(); } },
    ]);
  }
}
$('[data-goto=guide]').addEventListener('click', (e) => { e.preventDefault(); showView('guide'); });

function toggleListPane() {
  S.listPane = !S.listPane;
  app.classList.toggle('no-listpane', !S.listPane);
  $('#btn-listpane').classList.toggle('on', S.listPane);
  requestAnimationFrame(placePlayer); save();
}
$('#btn-listpane').addEventListener('click', toggleListPane);
$('#btn-full').addEventListener('click', () => host.win('fullscreen'));
$('#dock').addEventListener('click', (e) => { if (e.target.closest('#dock-bar')) showView('nowplaying'); });

// ---------------------------------------------------------------------------------------------
// Layout: transport centring and player placement
// ---------------------------------------------------------------------------------------------
const playerFrame = $('#player-frame');
app.appendChild(playerFrame); // inside #app so the transport bar can stack above it in full screen
function placePlayer() {
  let slot = null;
  if (app.classList.contains('has-media')) slot = view === 'nowplaying' ? $('#stage-slot') : $('#dock-slot');
  const r = slot && slot.getBoundingClientRect();
  if (!r || r.width < 2 || r.height < 2) { playerFrame.style.left = '-10000px'; return; }
  Object.assign(playerFrame.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
function layout() {
  const W = window.innerWidth;
  const small = W < 640;
  if (app.classList.contains('small-transport') !== small) toggleVolumePopup(false);
  app.classList.toggle('small-transport', small);
  const tw = small ? 274 : 558, tl = Math.round((W - tw) / 2) - 2;
  $('#transport').style.left = tl + 'px';
  const mqW = tl - 12;
  $('#marquee').style.width = Math.max(0, mqW) + 'px';
  $('#marquee').style.visibility = mqW > 90 ? 'visible' : 'hidden';
  app.classList.toggle('narrow', mqW <= 90);
  const st = $('#status'), sl = tl + tw + 4;
  st.style.left = sl + 'px'; st.style.width = Math.max(0, W - sl - 80) + 'px';
  placePlayer();
}
new ResizeObserver(layout).observe(document.body);
new ResizeObserver(placePlayer).observe($('#stage-slot'));

// ---------------------------------------------------------------------------------------------
// Window state, full screen
// ---------------------------------------------------------------------------------------------
const winState = { maximized: false, fullscreen: false };
let idleTimer = 0;
host.onWindowState((s) => {
  Object.assign(winState, s);
  app.classList.toggle('fullscreen', s.fullscreen);
  if (capBtns) capBtns.render();
  if (s.fullscreen && view !== 'nowplaying') showView('nowplaying');
  wake();
  requestAnimationFrame(placePlayer);
});
function wake() {
  app.classList.remove('idle');
  clearTimeout(idleTimer);
  if (winState.fullscreen) idleTimer = setTimeout(() => app.classList.add('idle'), 2500);
}
document.addEventListener('mousemove', wake);
host.onCursorMove(wake); // pointer moves over the video iframe don't reach this document
$('#titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('#capbtns')) host.win('max'); });
$('#stage').addEventListener('dblclick', () => host.win('fullscreen'));

// Clicking the video moves keyboard focus into the iframe; take it back so shortcuts keep working.
window.addEventListener('blur', () => setTimeout(() => {
  const a = document.activeElement;
  if (a && (a.tagName === 'IFRAME' || a.tagName === 'WEBVIEW') && playerFrame.contains(a)) { a.blur(); window.focus(); }
}, 0));

// ---------------------------------------------------------------------------------------------
// Input: search box, keyboard, drag & drop, paste, media keys
// ---------------------------------------------------------------------------------------------
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#search-input').value;
  if (!v.trim()) return;
  handleInput(v);
  $('#search-input').value = '';
  $('#search-input').blur();
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) { hideMenu(); return; }
    if (winState.fullscreen) { host.win('exit-fullscreen'); return; }
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey && !e.altKey;
  if (k === ' ' || (ctrl && k === 'p')) { e.preventDefault(); togglePlay(); }
  else if (ctrl && k === 's') { e.preventDefault(); stop(); }
  else if (ctrl && k === 'b') { e.preventDefault(); prev(); }
  else if (ctrl && k === 'f') { e.preventDefault(); next(false); }
  else if (ctrl && k === 'h') { e.preventDefault(); toggleShuffle(); }
  else if (ctrl && k === 't') { e.preventDefault(); toggleRepeat(); }
  else if (ctrl && k === 'l') { e.preventDefault(); toggleListPane(); }
  else if (ctrl && k === '1') showView('library');
  else if (ctrl && k === '3') showView('nowplaying');
  else if (ctrl && k === 'e') { e.preventDefault(); $('#search-input').focus(); }
  else if (e.key === 'F7') setMuted(!S.muted);
  else if (e.key === 'F8' || e.key === 'ArrowDown' && ctrl) setVolume(S.volume - 5);
  else if (e.key === 'F9' || e.key === 'ArrowUp' && ctrl) setVolume(S.volume + 5);
  else if (e.key === 'Enter' && e.altKey) host.win('fullscreen');
  else if (e.key === 'ArrowRight' && P.ready() && current()) P.seekTo(P.getCurrentTime() + (e.shiftKey ? 30 : 5), true);
  else if (e.key === 'ArrowLeft' && P.ready() && current()) P.seekTo(Math.max(0, P.getCurrentTime() - (e.shiftKey ? 30 : 5)), true);
  else if (e.key === 'Delete') {
    if (view === 'nowplaying' && lpSel.size) { removeFromQueue([...lpSel]); lpSel.clear(); }
    else if (view === 'library' && libSelRows.size) removeLibRows([...libSelRows]);
  }
});

document.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const text = e.clipboardData.getData('text');
  if (text && parseLink(text.split(/\s/)[0])) handleInput(text, { playNow: !current() });
});

document.addEventListener('dragover', (e) => { if (!dragPayload) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (dragPayload) return;
  e.preventDefault();
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) handleInput(text, { playNow: !current() });
});

host.onMedia((cmd) => ({ playpause: togglePlay, next: () => next(false), prev, stop })[cmd]());

// ---------------------------------------------------------------------------------------------
// Menus, dialogs, toast
// ---------------------------------------------------------------------------------------------
const menuEl = $('#menu');
function showMenu(x, y, items) {
  menuEl.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menuEl.appendChild(document.createElement('hr')); continue; }
    const d = document.createElement('div');
    d.textContent = it.label;
    if (it.checked) d.className = 'checked';
    if (it.disabled) d.classList.add('disabled');
    d.addEventListener('click', () => { hideMenu(); it.action(); });
    menuEl.appendChild(d);
  }
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  menuEl.style.top = (y + r.height > innerHeight ? Math.max(4, y - r.height) : y) + 'px';
}
function hideMenu() { menuEl.hidden = true; }
document.addEventListener('mousedown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu(); }, true);
window.addEventListener('blur', hideMenu);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

function promptName(label, initial) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    back.innerHTML = '<form class="dialog"><label></label><input type="text" maxlength="80"><div class="row"><button type="submit">OK</button><button type="button">Cancel</button></div></form>';
    back.querySelector('label').textContent = label;
    const input = back.querySelector('input'); input.value = initial || '';
    const close = (v) => { back.remove(); resolve(v); };
    back.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value.trim() || null); });
    back.querySelector('button[type=button]').addEventListener('click', () => close(null));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    document.body.appendChild(back);
    input.focus(); input.select();
  });
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------
(async function init() {
  try {
    await buildSkin();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:30px;font:14px Segoe UI;color:#fff">Skin images are missing (${err.message}).<br><br>Run <b>npm run skin</b> in the app folder, then restart.</div>`;
    return;
  }
  PATHS = await host.paths();
  const saved = await host.storeGet();
  for (const k of PERSIST) if (saved[k] !== undefined) S[k] = saved[k];
  if (S.index >= S.queue.length) S.index = S.queue.length - 1;
  app.classList.toggle('no-listpane', !S.listPane);
  $('#btn-listpane').classList.toggle('on', S.listPane);
  setupSliders();
  renderQueue(); renderNav(); updateNowPlayingMeta();
  if (current()) { setHasMedia(); loadIntoPlayer(current(), false, S.position || 0); } else warmUpPlayer();
  await showView('nowplaying');
  layout();
  updatePlayGlyph(); updateStatus();
  S.queue.forEach(lookupMeta);
})();

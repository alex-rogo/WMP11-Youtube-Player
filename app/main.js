const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage, net, screen, session, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const RENDERER = path.join(__dirname, 'renderer');
const SKIN = path.join(RENDERER, 'skin');
const PORT = +process.env.WMP_PORT || 47811; // fixed so the page origin (and YouTube's view of it) stays stable
const STORE = () => path.join(app.getPath('userData'), 'library.json');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

let win;

// Keep our data apart from anything belonging to the real Windows Media Player.
// WMP_PROFILE (testing): use a separate data folder, so a test run neither shares the user's
// library nor collides with their running copy through the single-instance lock.
app.setPath('userData', process.env.WMP_PROFILE || path.join(app.getPath('appData'), 'WMP11-YouTube'));

// YouTube's embedded player refuses to run from file:// pages, so the UI is served from loopback.
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.normalize(path.join(RENDERER, rel === '/' ? 'index.html' : rel));
      if (!file.startsWith(RENDERER)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE(), 'utf8')); } catch { return {}; }
}

function thumbIcon(name) {
  const p = path.join(SKIN, `g_${name}.png`);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

function setThumbar(playing) {
  if (!win || process.platform !== 'win32') return;
  const send = (cmd) => () => win.webContents.send('media', cmd);
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: thumbIcon('prev'), click: send('prev') },
    { tooltip: playing ? 'Pause' : 'Play', icon: thumbIcon(playing ? 'pause' : 'play'), click: send('playpause') },
    { tooltip: 'Next', icon: thumbIcon('next'), click: send('next') },
  ]);
}

function createWindow() {
  const saved = readStore().window || {};
  win = new BrowserWindow({
    width: saved.width || 980, height: saved.height || 700, x: saved.x, y: saved.y,
    minWidth: 560, minHeight: 420,
    frame: false, backgroundColor: '#000000', show: false,
    title: 'Windows Media Player',
    icon: fs.existsSync(path.join(SKIN, 'app.ico')) ? path.join(SKIN, 'app.ico') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webviewTag: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (saved.maximized) win.maximize();
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.once('ready-to-show', () => { win.show(); setThumbar(false); });

  // isFullScreen() can still be stale inside the full-screen events on frameless windows, so the
  // events report their own state.
  let fullscreen = false;
  const sendState = () => win.webContents.send('window-state', { maximized: win.isMaximized(), fullscreen });
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.on('enter-full-screen', () => { fullscreen = true; sendState(); });
  win.on('leave-full-screen', () => { fullscreen = false; sendState(); });

  // In full screen the video iframe swallows mouse moves and key presses, so watch the cursor
  // from here (to reveal the controls) and make Escape work regardless of focus.
  let cursorTimer = null, lastCursor = '';
  win.on('enter-full-screen', () => {
    globalShortcut.register('Escape', () => win.setFullScreen(false));
    cursorTimer = setInterval(() => {
      const p = screen.getCursorScreenPoint(), key = `${p.x},${p.y}`;
      if (key !== lastCursor) { lastCursor = key; win.webContents.send('cursor-move'); }
    }, 250);
  });
  win.on('leave-full-screen', () => {
    globalShortcut.unregister('Escape');
    clearInterval(cursorTimer); cursorTimer = null;
  });

  // Debug aids: WMP_DEBUG=1 echoes renderer console output; WMP_SNAPSHOT=<file.png> saves a
  // screenshot after WMP_SNAPSHOT_DELAY ms (default 4000) and quits.
  if (process.env.WMP_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(source || '')}:${line})`);
    });
  }
  if (process.env.WMP_SIZE) { const [w, h] = process.env.WMP_SIZE.split('x').map(Number); win.unmaximize(); win.setSize(w, h); }
  if (process.env.WMP_EVAL) {
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      win.webContents.executeJavaScript(process.env.WMP_EVAL).catch((e) => console.log('[eval]', e.message));
    }, 1500));
  }
  if (process.env.WMP_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.WMP_SNAPSHOT, img.toPNG());
      app.quit();
    }, +process.env.WMP_SNAPSHOT_DELAY || 4000));
  }

  win.on('close', () => {
    const data = readStore();
    data.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(STORE(), JSON.stringify(data, null, 1));
  });

  // Links that try to open new windows (e.g. "Watch on YouTube") go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.on('win', (_e, cmd) => {
  if (!win) return;
  if (cmd === 'min') win.minimize();
  else if (cmd === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (cmd === 'close') win.close();
  else if (cmd === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  else if (cmd === 'exit-fullscreen') win.setFullScreen(false);
});
ipcMain.on('playing', (_e, playing) => setThumbar(playing));
ipcMain.on('title', (_e, title) => win && win.setTitle(title));
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\/(www\.)?youtube\.com\//.test(url)) shell.openExternal(url); });

ipcMain.handle('store-get', () => readStore());
ipcMain.handle('store-set', (_e, data) => {
  const cur = readStore();
  fs.writeFileSync(STORE(), JSON.stringify({ ...data, window: cur.window }, null, 1));
});

// oEmbed gives title/channel/thumbnail without an API key; fetched here to avoid CORS.
ipcMain.handle('oembed', async (_e, videoId) => {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
    const r = await net.fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
});

ipcMain.handle('paths', () => ({
  webviewPreload: 'file:///' + path.join(__dirname, 'webview-preload.js').replace(/\\/g, '/'),
  playerPreload: 'file:///' + path.join(__dirname, 'player-preload.js').replace(/\\/g, '/'),
}));

// Ad blocking for the built-in browser (Now Playing's YouTube page and Media Guide). Ghostery's
// prebuilt ads + tracking lists; the compiled engine is cached so later starts don't re-download.
async function enableAdblock(sess) {
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking((url, init) => net.fetch(url, init), {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    blocker.enableBlockingInSession(sess);
    if (process.env.WMP_DEBUG) console.log('[adblock] enabled');
  } catch (e) {
    console.error('[adblock] could not start:', e.message);
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('WMP11.YouTube');
  // youtube.com inside the Media Guide tab: present as plain Chrome so the site serves its normal UI.
  const yt = session.fromPartition('persist:youtube');
  yt.setUserAgent(yt.getUserAgent().replace(/\s(Electron|wmp11-youtube)\/\S+/g, ''));
  await enableAdblock(yt);

  try { await startServer(); } catch (e) {
    console.error(`Could not listen on 127.0.0.1:${PORT}:`, e.message);
    app.quit(); return;
  }
  createWindow();

  const media = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
  for (const [key, cmd] of Object.entries(media)) {
    globalShortcut.register(key, () => win && win.webContents.send('media', cmd));
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
app.requestSingleInstanceLock() || app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

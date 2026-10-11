// Runs inside youtube.com in the Media Guide tab. Clicking a video hands it to the player
// instead of letting the site play it; right-click on a video offers queue options.
const { ipcRenderer } = require('electron');

function videoFromLink(a) {
  if (!a || !a.href) return null;
  let url;
  try { url = new URL(a.href, location.href); } catch { return null; }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  let id = null;
  if (url.pathname === '/watch') id = url.searchParams.get('v');
  else { const m = url.pathname.match(/^\/shorts\/([\w-]{11})/); if (m) id = m[1]; }
  const list = url.searchParams.get('list');
  if (!id && url.pathname === '/playlist' && list) return { list };
  if (!id || !/^[\w-]{11}$/.test(id)) return null;

  // Best-effort title from the surrounding result card; the player fills in the real one later.
  const card = a.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model') || a;
  const t = card.querySelector('#video-title, #video-title-link, .yt-lockup-metadata-view-model__title, h3');
  const title = ((t && (t.getAttribute('title') || t.textContent)) || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
  return { id, list: list && !list.startsWith('RD') ? list : null, title };
}

function linkFor(target) { return target.closest && target.closest('a[href]'); }

document.addEventListener('click', (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const v = videoFromLink(linkFor(e.target));
  if (!v) return;
  e.preventDefault(); e.stopImmediatePropagation();
  ipcRenderer.sendToHost('yt-pick', { ...v, action: 'play' });
}, true);

document.addEventListener('contextmenu', (e) => {
  const v = videoFromLink(linkFor(e.target));
  if (!v) return;
  e.preventDefault(); e.stopImmediatePropagation();
  ipcRenderer.sendToHost('yt-menu', { ...v, x: e.clientX, y: e.clientY });
}, true);

// If the site navigates to a watch page anyway (keyboard, autoplay), stop its own playback.
setInterval(() => {
  if (location.pathname === '/watch' || location.pathname.startsWith('/shorts/')) {
    document.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); });
  }
}, 500);

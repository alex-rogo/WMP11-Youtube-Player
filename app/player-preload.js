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

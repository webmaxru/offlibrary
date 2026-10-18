import { createOfflibrary, formatBytes, isBackgroundFetchSupported } from 'offlibrary';

// ---------------------------------------------------------------- setup
const STRATEGY_KEY = 'offlibrary-radio:strategy';
const strategy = localStorage.getItem(STRATEGY_KEY) ?? 'auto';
const THRESHOLD = 5 * 1024 * 1024;
const icon = new URL('icons/icon-192.png', location.href).href;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

const library = createOfflibrary({
  namespace: 'radio',
  collections: {
    episodes: {
      strategy,
      backgroundFetchThreshold: THRESHOLD,
      maxBytes: 250 * 1024 * 1024,
      ui: {
        icons: [{ src: icon, sizes: '192x192', type: 'image/png' }],
        title: (item) => `Downloading “${item.title}”`,
        successTitle: (item) => `“${item.title}” is ready to play offline`,
      },
      clickUrl: (item) => `./#${item.id}`,
    },
  },
});
const episodes = library.collection('episodes');
const bgSupported = isBackgroundFetchSupported();

// ---------------------------------------------------------------- DOM
const $ = (sel) => document.querySelector(sel);
const list = $('#episodes');
const audio = $('#audio');
const playerBar = $('#player-bar');
const logList = $('#log');
const strategySelect = $('#strategy');
strategySelect.value = strategy;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let feed = [];
let playingId = null;
let lastError = new Map();

function predictedTransport(ep) {
  if (!bgSupported || strategy === 'fetch') return 'fetch';
  if (strategy === 'background-fetch') return 'background-fetch';
  return ep.size >= THRESHOLD ? 'background-fetch' : 'fetch';
}
const transportLabel = (t) => (t === 'background-fetch' ? 'Background Fetch' : 'streaming fetch');

function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  logList.prepend(li);
  while (logList.children.length > 60) logList.lastChild.remove();
}

// ---------------------------------------------------------------- rendering
function renderEpisode(ep, index) {
  const item = episodes.peek(ep.id);
  const status = item?.status;
  let actions = '';
  if (!item) {
    const offline = !navigator.onLine;
    actions = `
      <button data-action="download" data-id="${esc(ep.id)}" ${offline ? 'disabled' : ''}>↓ Download</button>
      <button class="ghost small" data-action="play" data-id="${esc(ep.id)}" ${offline ? 'disabled' : ''}>▶ Stream</button>
      <span class="hint">via ${transportLabel(predictedTransport(ep))}</span>`;
  } else if (status === 'downloading' || status === 'paused') {
    const pct = item.progress === null ? null : Math.round(item.progress * 100);
    const total = item.total || ep.size;
    actions = `
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${pct === null ? '' : `aria-valuenow="${pct}"`}>
        <div class="bar ${pct === null ? 'indeterminate' : ''}"><span style="width:${pct ?? 0}%"></span></div>
        <small>${status === 'paused' ? 'Paused · ' : ''}${pct === null ? '' : `${pct}% · `}${formatBytes(item.downloaded)} of ${formatBytes(total)} · ${transportLabel(item.strategy)}</small>
      </div>
      ${
        status === 'paused'
          ? `<button class="small" data-action="resume" data-id="${esc(ep.id)}">Resume</button>`
          : item.strategy === 'fetch'
            ? `<button class="ghost small" data-action="pause" data-id="${esc(ep.id)}">Pause</button>`
            : ''
      }
      <button class="danger small" data-action="cancel" data-id="${esc(ep.id)}">Cancel</button>`;
  } else if (status === 'failed') {
    actions = `
      <span class="error">Download failed: ${esc(item.error?.message ?? 'unknown error')}</span>
      <button class="small" data-action="retry" data-id="${esc(ep.id)}">Retry</button>
      <button class="danger small" data-action="delete" data-id="${esc(ep.id)}">Remove</button>`;
  } else if (status === 'completed') {
    actions = `
      <span class="offline">✓ Available offline · ${formatBytes(item.bytes)}</span>
      <button class="small" data-action="play" data-id="${esc(ep.id)}">▶ Play</button>
      <button class="danger small" data-action="delete" data-id="${esc(ep.id)}">Delete</button>`;
  }
  const err = lastError.get(ep.id);
  return `
    <li class="episode ${playingId === ep.id ? 'playing' : ''}" id="${esc(ep.id)}">
      <div class="num" aria-hidden="true">${index + 1}</div>
      <h3>${esc(ep.title)}</h3>
      <div class="meta">${esc(ep.author)} · ${esc(ep.duration)} · ${formatBytes(ep.size)}</div>
      <div class="actions">${actions}${err ? `<span class="error">${esc(err)}</span>` : ''}</div>
    </li>`;
}

let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (feed.length) list.innerHTML = feed.map(renderEpisode).join('');
    renderChips();
  });
}

function renderChips() {
  const chips = [
    bgSupported ? ['ok', 'Background Fetch ✓'] : ['warn', 'No Background Fetch → resumable fetch'],
    navigator.onLine ? ['ok', 'Online'] : ['off', 'Offline'],
  ];
  $('#chips').innerHTML = chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('');
}

let storageTimer;
function renderStorageSoon() {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(renderStorage, 250);
}
let storageSeq = 0;
async function renderStorage() {
  const seq = ++storageSeq;
  const [est, usage, persisted] = await Promise.all([library.storage.estimate(), episodes.usage(), library.storage.persisted()]);
  if (seq !== storageSeq) return; // a newer render is on its way
  const quota = est.quota || 1;
  // Keep a sliver visible: a few MB of a multi-GB quota would otherwise render as nothing.
  const mine = usage.bytes ? Math.max(1, Math.min(100, (usage.bytes / quota) * 100)) : 0;
  const other = Math.max(0, Math.min(100 - mine, ((est.usage - usage.bytes) / quota) * 100));
  $('#storage').innerHTML = `
    <h2>Storage</h2>
    <div class="meter" title="Episodes / other site data / free">
      <span class="mine" style="width:${mine.toFixed(2)}%"></span><span class="other" style="width:${other.toFixed(2)}%"></span>
    </div>
    <div class="row">
      <span><strong>${usage.count}</strong> episode${usage.count === 1 ? '' : 's'} · <strong>${formatBytes(usage.bytes)}</strong> offline</span>
      <span>${est.supported ? `${formatBytes(est.usage)} used of ${formatBytes(est.quota)} available to this site` : 'Storage estimate not supported'}</span>
    </div>
    <div class="row">
      <span>Persistent storage: <strong>${persisted ? 'yes, the browser will not evict it' : 'no, best-effort'}</strong></span>
      <span>
        ${persisted || !library.capabilities.storagePersist ? '' : '<button class="ghost small" data-action="persist">Make persistent</button>'}
        ${usage.count ? '<button class="danger small" data-action="clear">Delete all</button>' : ''}
      </span>
    </div>`;
}

// ---------------------------------------------------------------- actions
function play(ep) {
  const item = episodes.peek(ep.id);
  playingId = ep.id;
  playerBar.hidden = false;
  $('#now-title').textContent = ep.title;
  const offline = item?.status === 'completed';
  const badge = $('#now-source');
  badge.textContent = offline ? 'Playing from offline storage' : 'Streaming';
  badge.className = `badge ${offline ? 'offline' : ''}`;
  // Always the original URL: the service worker answers it from the offline copy (with Range support).
  if (audio.dataset.id !== ep.id) {
    audio.src = ep.url;
    audio.dataset.id = ep.id;
  }
  audio.play().catch(() => {});
  if (offline) episodes.touch(ep.id).catch(() => {});
  render();
}

async function act(action, id) {
  const ep = feed.find((e) => e.id === id);
  lastError.delete(id);
  try {
    switch (action) {
      case 'download':
        await episodes.download({ id: ep.id, url: ep.url, title: ep.title, size: ep.size, meta: { author: ep.author } });
        break;
      case 'pause':
        await episodes.pause(id);
        break;
      case 'resume':
      case 'retry':
        await episodes.resume(id);
        break;
      case 'cancel':
        await episodes.cancel(id);
        break;
      case 'delete':
        if (playingId === id) {
          audio.pause();
          audio.removeAttribute('src');
          delete audio.dataset.id;
          playerBar.hidden = true;
          playingId = null;
        }
        await episodes.delete(id);
        break;
      case 'play':
        play(ep);
        break;
      case 'persist':
        log(`persist() → ${await library.storage.persist()}`);
        renderStorage();
        break;
      case 'clear':
        await episodes.clear();
        break;
    }
  } catch (error) {
    lastError.set(id, error.message);
    log(`${action} ${id ?? ''} failed: ${error.code ?? ''} ${error.message}`);
  }
  render();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) act(btn.dataset.action, btn.dataset.id);
});
$('#download-all').addEventListener('click', async () => {
  const missing = feed.filter((ep) => !episodes.peek(ep.id));
  const results = await episodes.downloadAll(missing.map((ep) => ({ id: ep.id, url: ep.url, title: ep.title, size: ep.size, meta: { author: ep.author } })));
  results.forEach((r, i) => r.status === 'rejected' && lastError.set(missing[i].id, r.reason.message));
  render();
});
strategySelect.addEventListener('change', () => {
  localStorage.setItem(STRATEGY_KEY, strategySelect.value);
  location.reload();
});
addEventListener('online', render);
addEventListener('offline', render);

// ---------------------------------------------------------------- library events
library.subscribe(({ type }) => {
  render();
  if (type !== 'progress') renderStorageSoon();
});
library.on('complete', ({ item }) => log(`complete  ${item.title} (${formatBytes(item.bytes)}, ${transportLabel(item.strategy)})`));
library.on('error', ({ item, error }) => log(`error     ${item.title}: ${error.code} ${error.message}`));
library.on('abort', ({ item }) => log(`abort     ${item.title}`));
library.on('delete', ({ item }) => log(`delete    ${item.title}`));
library.on('evict', ({ item, reason }) => log(`evict     ${item.title} (${reason})`));
library.on('change', ({ item, type }) => ['start', 'pause', 'resume'].includes(type) && log(`${type.padEnd(9)} ${item.title} via ${transportLabel(item.strategy)}`));
library.on('click', ({ item }) => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));

// ---------------------------------------------------------------- boot
(async () => {
  try {
    const res = await fetch('episodes.json');
    feed = (await res.json()).episodes;
  } catch {
    list.innerHTML = '<li class="loading">Could not load the episode list. Are you offline on the first visit?</li>';
    return;
  }
  await library.ready;
  await episodes.sync(feed.map((ep) => ({ id: ep.id, title: ep.title })));
  render();
  renderStorage();
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'center' }));
  window.offlibraryDemo = { library, episodes }; // handy in DevTools
})();

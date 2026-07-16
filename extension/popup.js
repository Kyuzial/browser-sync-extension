/* ==========================================================================
   Popup Logic — Browser Sync Extension
   Manages UI state, triggers sync, and opens options page.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const syncIcon       = $('#syncIcon');
const statusBadge    = $('#statusBadge');
const statusDot      = $('#statusDot');
const statusText     = $('#statusText');
const lastSyncTime   = $('#lastSyncTime');
const bookmarkCount  = $('#bookmarkCount');
const syncNowBtn     = $('#syncNowBtn');
const openOptionsBtn = $('#openOptions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a timestamp into a human-friendly relative string. */
function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';

  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);

  if (seconds < 60)  return 'Just now';
  if (minutes < 60)  return `${minutes}m ago`;
  if (hours < 24)    return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Check server connectivity via the background script. */
async function checkConnection() {
  try {
    const settings = await chrome.storage.local.get(['serverUrl', 'apiKey']);
    if (!settings.serverUrl || !settings.apiKey) {
      setConnectionStatus(false, 'Not configured');
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: 'testConnection',
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey,
    });

    if (response?.ok) {
      setConnectionStatus(true, 'Connected');
    } else {
      setConnectionStatus(false, 'Unreachable');
    }
  } catch {
    setConnectionStatus(false, 'Error');
  }
}

function setConnectionStatus(connected, label) {
  statusDot.classList.toggle('connected', connected);
  statusText.textContent = label;
  statusBadge.title = label;
}

// ---------------------------------------------------------------------------
// Load current status from background
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (!status) return;

    const latestSync = status.lastBookmarkSync || 0;
    lastSyncTime.textContent  = formatRelativeTime(latestSync || null);
    bookmarkCount.textContent = (status.bookmarkCount || 0).toLocaleString();
  } catch {
    // Background may not be ready yet — ignore
  }
}

// ---------------------------------------------------------------------------
// Sync Now button
// ---------------------------------------------------------------------------

syncNowBtn.addEventListener('click', async () => {
  syncNowBtn.disabled = true;
  document.body.classList.add('syncing');
  syncNowBtn.querySelector('span').textContent = 'Syncing…';

  try {
    const result = await chrome.runtime.sendMessage({ action: 'syncAll' });

    // Update stats immediately after sync
    await loadStatus();

    if (result?.bookmarks?.success) {
      syncNowBtn.querySelector('span').textContent = 'Done!';
    } else {
      syncNowBtn.querySelector('span').textContent = 'Failed';
    }
  } catch {
    syncNowBtn.querySelector('span').textContent = 'Failed';
  }

  document.body.classList.remove('syncing');

  // Reset button label after a brief pause
  setTimeout(() => {
    syncNowBtn.querySelector('span').textContent = 'Sync Now';
    syncNowBtn.disabled = false;
  }, 1500);
});

// ---------------------------------------------------------------------------
// Open options page
// ---------------------------------------------------------------------------

openOptionsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  checkConnection();
});

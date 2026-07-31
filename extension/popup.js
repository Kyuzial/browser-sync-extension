/* ==========================================================================
   Popup Logic — Browser Sync Extension
   Manages UI state, triggers sync, opens options page, and displays
   synced open tabs from other devices.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const syncIcon          = $('#syncIcon');
const statusBadge       = $('#statusBadge');
const statusDot         = $('#statusDot');
const statusText        = $('#statusText');
const lastSyncTime      = $('#lastSyncTime');
const bookmarkCount     = $('#bookmarkCount');
const tabCount          = $('#tabCount');
const syncNowBtn        = $('#syncNowBtn');
const openOptionsBtn    = $('#openOptions');

const syncedTabsSection = $('#syncedTabsSection');
const otherTabsHeader   = $('#otherTabsHeader');
const otherDevicesCount = $('#otherDevicesCount');
const deviceList        = $('#deviceList');
const emptyTabsMessage  = $('#emptyTabsMessage');

// Default fallback tab icon (SVG data URI)
const FALLBACK_FAVICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%23aaaaaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

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
// Collapsible state handling
// ---------------------------------------------------------------------------

async function initCollapsibleStates() {
  const { isMainTabsSectionCollapsed, collapsedDevices } = await chrome.storage.local.get({
    isMainTabsSectionCollapsed: false,
    collapsedDevices: {},
  });

  if (isMainTabsSectionCollapsed) {
    syncedTabsSection.classList.add('collapsed');
  }

  otherTabsHeader.addEventListener('click', async () => {
    const isNowCollapsed = syncedTabsSection.classList.toggle('collapsed');
    await chrome.storage.local.set({ isMainTabsSectionCollapsed: isNowCollapsed });
  });

  otherTabsHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      otherTabsHeader.click();
    }
  });
}

// ---------------------------------------------------------------------------
// Load & Render open tabs from other devices
// ---------------------------------------------------------------------------

async function loadOtherTabs() {
  try {
    const { collapsedDevices = {} } = await chrome.storage.local.get('collapsedDevices');
    const response = await chrome.runtime.sendMessage({ action: 'getOtherTabs' });

    if (!response?.success || !response.devices || response.devices.length === 0) {
      otherDevicesCount.textContent = '0';
      deviceList.innerHTML = '';
      emptyTabsMessage.style.display = 'block';
      return;
    }

    const devices = response.devices;
    let totalTabs = 0;
    deviceList.innerHTML = '';

    devices.forEach((device) => {
      const deviceTabs = device.tabs || [];
      totalTabs += deviceTabs.length;

      const deviceIdStr = String(device.device_id);
      const isDeviceCollapsed = !!collapsedDevices[deviceIdStr];

      const deviceEl = document.createElement('div');
      deviceEl.className = `device-item ${isDeviceCollapsed ? 'collapsed' : ''}`;
      deviceEl.dataset.deviceId = deviceIdStr;

      deviceEl.innerHTML = `
        <div class="device-header" role="button" tabindex="0">
          <div class="device-header-left">
            <svg class="device-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <span class="device-name">${escapeHtml(device.device_name)}</span>
            <span class="device-tab-count">(${deviceTabs.length})</span>
          </div>
          <svg class="chevron-icon device-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="device-tabs-list"></div>
      `;

      const header = deviceEl.querySelector('.device-header');
      const tabsListContainer = deviceEl.querySelector('.device-tabs-list');

      header.addEventListener('click', async () => {
        const collapsed = deviceEl.classList.toggle('collapsed');
        const currentStored = (await chrome.storage.local.get('collapsedDevices')).collapsedDevices || {};
        currentStored[deviceIdStr] = collapsed;
        await chrome.storage.local.set({ collapsedDevices: currentStored });
      });

      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          header.click();
        }
      });

      if (deviceTabs.length === 0) {
        tabsListContainer.innerHTML = '<div class="empty-tabs-message">No active tabs</div>';
      } else {
        deviceTabs.forEach((tab) => {
          const tabAnchor = document.createElement('a');
          tabAnchor.className = 'tab-item';
          tabAnchor.href = tab.url;
          tabAnchor.title = tab.title || tab.url;

          const favSrc = tab.fav_icon_url && tab.fav_icon_url.trim() ? escapeHtml(tab.fav_icon_url) : FALLBACK_FAVICON;

          tabAnchor.innerHTML = `
            <img class="tab-favicon" src="${favSrc}" alt="" />
            <div class="tab-details">
              <span class="tab-title">${escapeHtml(tab.title || tab.url)}</span>
              <span class="tab-url">${escapeHtml(tab.url)}</span>
            </div>
          `;

          const img = tabAnchor.querySelector('.tab-favicon');
          img.addEventListener('error', () => {
            img.src = FALLBACK_FAVICON;
          });

          tabAnchor.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: tab.url });
          });

          tabsListContainer.appendChild(tabAnchor);
        });
      }

      deviceList.appendChild(deviceEl);
    });

    otherDevicesCount.textContent = totalTabs.toString();
    emptyTabsMessage.style.display = totalTabs > 0 ? 'none' : 'block';
  } catch (err) {
    console.error('[BrowserSync] Error loading other tabs:', err);
    emptyTabsMessage.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Load current status from background
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (!status) return;

    const latestSync = status.lastBookmarkSync || status.lastTabSync || 0;
    lastSyncTime.textContent  = formatRelativeTime(latestSync || null);
    bookmarkCount.textContent = (status.bookmarkCount || 0).toLocaleString();
    if (tabCount) {
      tabCount.textContent = (status.tabCount || 0).toLocaleString();
    }
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

    // Update stats & tabs immediately after sync
    await loadStatus();
    await loadOtherTabs();

    if (result?.bookmarks?.success || result?.tabs?.success) {
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
  initCollapsibleStates();
  loadOtherTabs();
});

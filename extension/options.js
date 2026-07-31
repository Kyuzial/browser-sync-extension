/* ==========================================================================
   Options Logic — Browser Sync Extension
   Loads, saves, and validates settings. Tests server connectivity.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const serverUrlInput     = $('#serverUrl');
const apiKeyInput        = $('#apiKey');
const toggleKeyBtn       = $('#toggleKeyVisibility');
const testConnectionBtn  = $('#testConnectionBtn');
const connectionResult   = $('#connectionResult');
const autoSyncBookmarks  = $('#autoSyncBookmarks');
const autoSyncTabs       = $('#autoSyncTabs');
const forceSyncBtn       = $('#forceSyncBtn');
const saveBtn            = $('#saveBtn');
const toast              = $('#toast');

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

let toastTimeout = null;

function showToast(message, durationMs = 2500) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), durationMs);
}

// ---------------------------------------------------------------------------
// Load settings into form
// ---------------------------------------------------------------------------

async function loadSettings() {
  const data = await chrome.storage.local.get({
    serverUrl: '',
    apiKey: '',
    autoSyncBookmarks: true,
    autoSyncTabs: true,
  });

  serverUrlInput.value            = data.serverUrl;
  apiKeyInput.value               = data.apiKey;
  autoSyncBookmarks.checked       = data.autoSyncBookmarks;
  if (autoSyncTabs) {
    autoSyncTabs.checked          = data.autoSyncTabs !== false;
  }
}

// ---------------------------------------------------------------------------
// Save settings
// ---------------------------------------------------------------------------

saveBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  const key = apiKeyInput.value.trim();

  const settings = {
    serverUrl:         url,
    apiKey:            key,
    autoSyncBookmarks: autoSyncBookmarks.checked,
    autoSyncTabs:      autoSyncTabs ? autoSyncTabs.checked : true,
  };

  if (!url) {
    await chrome.storage.local.set(settings);
    showToast('✓ Settings cleared');
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    showToast('✗ Server URL must start with http:// or https://');
    return;
  }

  const origin = url + '/*';
  chrome.permissions.request({
    origins: [origin]
  }, async (granted) => {
    if (granted) {
      await chrome.storage.local.set(settings);
      showToast('✓ Settings saved');
      try {
        await chrome.runtime.sendMessage({ action: 'syncAll' });
      } catch (e) {}
    } else {
      showToast('✗ Permission required to sync with this server');
    }
  });
});

// ---------------------------------------------------------------------------
// Toggle API key visibility
// ---------------------------------------------------------------------------

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.title = isPassword ? 'Hide' : 'Show';
});

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

testConnectionBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  const key = apiKeyInput.value.trim();

  if (!url) {
    setResult('Enter a server URL first', false);
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    setResult('Server URL must start with http:// or https://', false);
    return;
  }

  testConnectionBtn.disabled = true;
  testConnectionBtn.querySelector('span').textContent = 'Testing…';
  connectionResult.textContent = '';
  connectionResult.className = 'connection-result';

  const origin = url + '/*';
  chrome.permissions.request({
    origins: [origin]
  }, async (granted) => {
    if (!granted) {
      setResult('✗ Permission denied for server URL', false);
      testConnectionBtn.disabled = false;
      testConnectionBtn.querySelector('span').textContent = 'Test Connection';
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testConnection',
        serverUrl: url,
        apiKey: key,
      });

      if (response?.ok) {
        setResult('✓ Connected successfully', true);
      } else {
        setResult(`✗ Server returned ${response?.status || 'an error'}`, false);
      }
    } catch (err) {
      setResult(`✗ ${err.message || 'Connection failed'}`, false);
    }

    testConnectionBtn.disabled = false;
    testConnectionBtn.querySelector('span').textContent = 'Test Connection';
  });
});

function setResult(message, success) {
  connectionResult.textContent = message;
  connectionResult.className = `connection-result ${success ? 'success' : 'error'}`;
}

// ---------------------------------------------------------------------------
// Force Sync
// ---------------------------------------------------------------------------

if (forceSyncBtn) {
  forceSyncBtn.addEventListener('click', async () => {
    forceSyncBtn.disabled = true;
    forceSyncBtn.textContent = 'Uploading…';
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'forceSync' });
      if (response && response.success) {
        showToast(`✓ Force upload successful (${response.count} bookmarks)`);
      } else {
        showToast(`✗ Force upload failed: ${response?.error || 'Unknown error'}`);
      }
    } catch (err) {
      showToast(`✗ Error: ${err.message}`);
    } finally {
      forceSyncBtn.disabled = false;
      forceSyncBtn.textContent = 'Force Upload';
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', loadSettings);

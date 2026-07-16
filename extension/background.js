/* ==========================================================================
   Background Service Worker — Browser Sync Extension
   Handles bookmark & history sync with debouncing, alarms, and retry logic.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES    = 3;
const DEBOUNCE_DELAY = 5000; // ms — wait after last bookmark change

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isSyncingBookmarks = false;
let bookmarkDebounceTimer = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** Read settings from chrome.storage.local. */
async function getSettings() {
  const defaults = {
    serverUrl: '',
    apiKey: '',
    autoSyncBookmarks: true,
    lastBookmarkSync: null,
    bookmarkCount: 0,
    lastSyncedBookmarks: [],
  };
  const data = await chrome.storage.local.get(defaults);
  return data;
}

/** Persist a partial settings update. */
async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated fetch to the configured server.
 * Retries up to MAX_RETRIES times with exponential back-off on failure.
 */
async function apiFetch(path, options = {}, retries = MAX_RETRIES) {
  const { serverUrl, apiKey } = await getSettings();

  if (!serverUrl || !apiKey) {
    throw new Error('Server URL or API key not configured');
  }

  const url = `${serverUrl.replace(/\/+$/, '')}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...(options.headers || {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Some endpoints may return empty bodies (204 etc.)
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) throw err;

      // Exponential back-off: 1s → 2s → 4s …
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[BrowserSync] Attempt ${attempt + 1} failed, retrying in ${delay}ms…`, err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Bookmark sync
// ---------------------------------------------------------------------------

function isBookmarksBar(title) {
  const t = title.toLowerCase();
  return t === 'bookmarks bar' || t === 'bookmarks' || t === 'bookmark bar' || t === 'favorites bar';
}

function isOtherBookmarks(title) {
  const t = title.toLowerCase();
  return t === 'other bookmarks' || t === 'other' || t === 'unsorted bookmarks';
}

function isMobileBookmarks(title) {
  const t = title.toLowerCase();
  return t === 'mobile bookmarks' || t === 'mobile';
}

function normalizeRootTitle(title) {
  if (isBookmarksBar(title)) return 'Bookmarks Bar';
  if (isOtherBookmarks(title)) return 'Other Bookmarks';
  if (isMobileBookmarks(title)) return 'Mobile Bookmarks';
  return title;
}

/** Helper to delete a bookmark locally by url and folder path. */
async function deleteBookmarkLocally(url, folderPath) {
  try {
    const nodes = await chrome.bookmarks.search({ url });
    for (const node of nodes) {
      const path = await getBookmarkFolderPath(node.id);
      if (path === folderPath) {
        await chrome.bookmarks.remove(node.id);
      }
    }
  } catch (err) {
    console.error(`[BrowserSync] Failed to delete bookmark ${url} under ${folderPath}:`, err);
  }
}

/** Helper to walk up and construct the folder path of a bookmark. */
async function getBookmarkFolderPath(nodeId) {
  const pathSegments = [];
  try {
    const node = (await chrome.bookmarks.get(nodeId))[0];
    let parentId = node.parentId;
    while (parentId && parentId !== '0') {
      const parent = (await chrome.bookmarks.get(parentId))[0];
      const title = parent.parentId === '0' ? normalizeRootTitle(parent.title) : parent.title;
      pathSegments.unshift(title);
      parentId = parent.parentId;
    }
  } catch (e) {
    // Ignore errors
  }
  return pathSegments.join('/');
}

/** Helper to ensure folder path exists and return parent ID. */
async function ensureFolderAndGetId(folderPath) {
  const segments = folderPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '2'; // Default to "Other Bookmarks"
  }

  const tree = await chrome.bookmarks.getTree();
  const rootChildren = tree[0].children || [];
  
  const firstSegment = segments[0];
  let currentNodes = [];
  let parentId = '2';

  let rootFolder = null;
  if (isBookmarksBar(firstSegment)) {
    rootFolder = rootChildren[0];
  } else if (isOtherBookmarks(firstSegment)) {
    rootFolder = rootChildren[1] || rootChildren[0];
  } else if (isMobileBookmarks(firstSegment)) {
    rootFolder = rootChildren[2] || rootChildren[1] || rootChildren[0];
  } else {
    rootFolder = rootChildren.find(n => n.title.toLowerCase() === firstSegment.toLowerCase() && !n.url);
  }

  if (rootFolder) {
    parentId = rootFolder.id;
    currentNodes = rootFolder.children || [];
  } else {
    const created = await chrome.bookmarks.create({
      parentId: '2',
      title: firstSegment
    });
    parentId = created.id;
    currentNodes = [];
  }

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    let found = currentNodes.find(n => n.title.toLowerCase() === segment.toLowerCase() && !n.url);
    if (!found) {
      found = await chrome.bookmarks.create({
        parentId: parentId,
        title: segment
      });
      found.children = [];
    }
    parentId = found.id;
    currentNodes = found.children || [];
  }

  return parentId;
}

/**
 * Flatten the bookmark tree into a flat list with folder paths.
 * Each entry: { url, title, folder_path }
 */
function flattenBookmarks(nodes, parentPath = '') {
  const results = [];

  for (const node of nodes) {
    const normalizedTitle = node.parentId === '0' ? normalizeRootTitle(node.title) : node.title;

    const currentPath = parentPath
      ? `${parentPath}/${normalizedTitle}`
      : normalizedTitle;

    if (node.url) {
      results.push({
        url: node.url,
        title: node.title || '',
        folder_path: parentPath,
      });
    }

    if (node.children) {
      results.push(...flattenBookmarks(node.children, currentPath));
    }
  }

  return results;
}

/** Perform robust 3-way merge on bookmarks. */
async function syncBookmarks() {
  if (isSyncingBookmarks) {
    return { success: true, skipped: true };
  }
  isSyncingBookmarks = true;
  console.log('[BrowserSync] Syncing bookmarks…');

  try {
    const settings = await getSettings();
    if (!settings.serverUrl || !settings.apiKey) {
      console.log('[BrowserSync] Sync skipped: Server URL or API key not configured.');
      return { success: false, error: 'Not configured' };
    }
    const last = settings.lastSyncedBookmarks || [];

    // 1. Fetch server bookmarks
    const server = await apiFetch('/api/bookmarks', { method: 'GET' }) || [];

    // 2. Fetch local bookmarks
    const tree = await chrome.bookmarks.getTree();
    const local = flattenBookmarks(tree);

    // 3. Map for quick lookups
    const keyFn = b => `${b.folder_path}|||${b.url}`;
    const localMap = new Map(local.map(b => [keyFn(b), b]));
    const serverMap = new Map(server.map(b => [keyFn(b), b]));
    const lastMap = new Map(last.map(b => [keyFn(b), b]));

    const toCreateLocally = [];
    const toDeleteLocally = [];
    const toUpload = [];

    const allKeys = new Set([
      ...localMap.keys(),
      ...serverMap.keys(),
      ...lastMap.keys()
    ]);

    for (const key of allKeys) {
      const loc = localMap.get(key);
      const srv = serverMap.get(key);
      const lst = lastMap.get(key);

      if (loc && srv) {
        let title = srv.title;
        if (lst && loc.title !== lst.title) {
          title = loc.title;
        }
        toUpload.push({ url: loc.url, title, folder_path: loc.folder_path });
      } else if (loc && !srv) {
        if (lst) {
          toDeleteLocally.push(loc);
        } else {
          toUpload.push(loc);
        }
      } else if (!loc && srv) {
        if (lst) {
          // Was deleted locally, so do not upload (server will remove it)
        } else {
          toCreateLocally.push(srv);
          toUpload.push(srv);
        }
      }
    }

    // 4. Apply deletions locally
    for (const bm of toDeleteLocally) {
      await deleteBookmarkLocally(bm.url, bm.folder_path);
    }

    // 5. Apply additions locally
    for (const bm of toCreateLocally) {
      const parentId = await ensureFolderAndGetId(bm.folder_path);
      await chrome.bookmarks.create({
        parentId,
        title: bm.title,
        url: bm.url
      });
    }

    // 6. Get final local state to save/upload
    const finalTree = await chrome.bookmarks.getTree();
    const finalLocal = flattenBookmarks(finalTree);

    await apiFetch('/api/bookmarks', {
      method: 'PUT',
      body: JSON.stringify({ bookmarks: finalLocal }),
    });

    await saveSettings({
      lastBookmarkSync: Date.now(),
      bookmarkCount: finalLocal.length,
      lastSyncedBookmarks: finalLocal,
    });

    console.log(`[BrowserSync] Bookmarks merged — ${finalLocal.length} total bookmarks`);
    return { success: true, count: finalLocal.length };
  } catch (err) {
    console.error('[BrowserSync] Bookmark sync failed:', err);
    return { success: false, error: err.message };
  } finally {
    isSyncingBookmarks = false;
  }
}

/** Debounced bookmark sync — resets the timer on every call. */
function debouncedBookmarkSync() {
  if (isSyncingBookmarks) return;
  if (bookmarkDebounceTimer) {
    clearTimeout(bookmarkDebounceTimer);
  }

  bookmarkDebounceTimer = setTimeout(async () => {
    bookmarkDebounceTimer = null;
    const settings = await getSettings();
    if (settings.autoSyncBookmarks) {
      await syncBookmarks();
    }
  }, DEBOUNCE_DELAY);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// -- Bookmark events (debounced) --
chrome.bookmarks.onCreated.addListener(debouncedBookmarkSync);
chrome.bookmarks.onRemoved.addListener(debouncedBookmarkSync);
chrome.bookmarks.onChanged.addListener(debouncedBookmarkSync);
chrome.bookmarks.onMoved.addListener(debouncedBookmarkSync);

// -- Message handler (popup & options communicate via messages) --
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // We must return true to indicate we will respond asynchronously.
  (async () => {
    try {
      switch (message.action) {
        case 'syncAll': {
          const result = await syncBookmarks();
          sendResponse({ bookmarks: result });
          break;
        }

        case 'syncBookmarks': {
          const result = await syncBookmarks();
          sendResponse(result);
          break;
        }

        case 'testConnection': {
          const { serverUrl, apiKey } = message;
          const url = `${serverUrl.replace(/\/+$/, '')}/api/health`;
          const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });
          sendResponse({ ok: res.ok, status: res.status });
          break;
        }

        case 'getStatus': {
          try {
            const stats = await apiFetch('/api/status', { method: 'GET' });
            sendResponse(stats);
          } catch (e) {
            const settings = await getSettings();
            sendResponse({
              lastBookmarkSync: settings.lastBookmarkSync,
              bookmarkCount: settings.bookmarkCount,
            });
          }
          break;
        }

        case 'updateAlarm': {
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});

// -- Extension installed / updated --
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BrowserSync] Extension installed / updated');
  syncBookmarks();
});

// -- Service worker startup --
chrome.runtime.onStartup.addListener(() => {
  console.log('[BrowserSync] Service worker started');
  syncBookmarks();
});

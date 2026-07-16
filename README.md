# Browser Sync

A self-hosted Chrome extension + Python backend for syncing bookmarks across devices. No Google services, no cloud dependencies — your data stays on your server.

## Architecture

```
┌──────────────┐         HTTPS          ┌──────────────┐
│   Chrome     │  ◄──────────────────►  │   FastAPI     │
│   Extension  │   Bearer token auth    │   Backend     │
│  (Manifest V3)│                       │  + SQLite DB  │
└──────────────┘                        └──────────────┘
```

- **Backend**: FastAPI + SQLite — lightweight, zero external services
- **Extension**: Manifest V3 — vanilla JS, no build tools
- **Auth**: API key (Bearer token), keys stored as SHA-256 hashes
- **Sync**: Bookmarks synced bi-directionally on change

## Quick Start

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env as needed

# Create an API key for your browser
python main.py create-key "my-laptop"
# Save the displayed key — it's shown only once

# Run the server
python main.py serve
```

### 2. Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon → **Settings**
5. Enter your server URL (e.g. `http://localhost:8000`) and the API key
6. Click **Test Connection** → should show green
7. Click **Save**

## API Key Management

```bash
# Create a new key
python main.py create-key "work-pc"

# List all keys
python main.py list-keys

# Revoke a key
python main.py revoke-key <key-id>
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/status` | Live sync stats |
| `PUT` | `/api/bookmarks` | Sync bookmarks (3-way merge) |
| `GET` | `/api/bookmarks` | Get all bookmarks |

All data endpoints require `Authorization: Bearer <api-key>` header.

## Security Notes

- API keys are hashed (SHA-256) before storage — the raw key is never persisted
- Use HTTPS in production (put behind nginx/caddy with TLS)
- CORS origins are configurable via `.env`
- Rate limited to 60 requests/minute per key
- No data leaves your server

## Project Structure

```
├── backend/
│   ├── main.py          # FastAPI app + CLI
│   ├── db.py            # Database layer
│   ├── auth.py          # API key auth
│   ├── models.py        # Pydantic models
│   ├── requirements.txt
│   └── .env.example
├── extension/
│   ├── manifest.json
│   ├── background.js    # Service worker (sync logic)
│   ├── popup.html/css/js
│   └── options.html/css/js
├── .gitignore
└── README.md
```

## License

MIT

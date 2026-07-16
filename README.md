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

Choose one of the following options to run the backend:

#### Option A: Docker Compose (Recommended)

1. Make sure you have Docker and Docker Compose installed.
2. Navigate to the `backend/` directory and configure the environment:
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env as needed (e.g., configure CORS_ORIGINS)
   ```
   For details, inspect [docker-compose.yml](file:///home/pierre/Project/browser-sync-extension/backend/docker-compose.yml).
3. Start the service in the background:
   ```bash
   docker compose up -d
   ```
4. Create an API key for your browser by running [main.py](file:///home/pierre/Project/browser-sync-extension/backend/main.py) inside the container:
   ```bash
   docker compose exec backend python main.py create-key "my-laptop"
   # Save the displayed key — it's shown only once
   ```

#### Option B: Docker CLI (Alternative)

1. Navigate to the `backend/` directory and configure the environment:
   ```bash
   cd backend
   cp .env.example .env
   ```
2. Build the Docker image using [Dockerfile](file:///home/pierre/Project/browser-sync-extension/backend/Dockerfile):
   ```bash
   docker build -t browser-sync-backend .
   ```
3. Run the container with a persistent volume for the SQLite database:
   ```bash
   docker run -d \
     --name browser-sync-backend \
     -p 127.0.0.1:8000:8000 \
     -v browser-sync-data:/data \
     --env-file .env \
     browser-sync-backend
   ```
4. Create an API key for your browser by running [main.py](file:///home/pierre/Project/browser-sync-extension/backend/main.py) inside the container:
   ```bash
   docker exec -it browser-sync-backend python main.py create-key "my-laptop"
   # Save the displayed key — it's shown only once
   ```

#### Option C: Local Python Setup (No Docker)

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

Depending on how you run the backend, use the corresponding commands to execute key management via [main.py](file:///home/pierre/Project/browser-sync-extension/backend/main.py).

### With Docker Compose
```bash
# Create a new key
docker compose exec backend python main.py create-key "work-pc"

# List all keys
docker compose exec backend python main.py list-keys

# Revoke a key
docker compose exec backend python main.py revoke-key <key-id>
```

### With Docker CLI
```bash
# Create a new key
docker exec -it browser-sync-backend python main.py create-key "work-pc"

# List all keys
docker exec -it browser-sync-backend python main.py list-keys

# Revoke a key
docker exec -it browser-sync-backend python main.py revoke-key <key-id>
```

### With Local Python
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

## Development

This project uses `ruff` for code formatting and linting.

```bash
cd backend
pip install ruff
ruff check .
```

## License

MIT

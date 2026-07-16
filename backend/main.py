"""
Browser Sync — FastAPI backend & CLI for bookmark/history synchronisation.

Run the server:
    uvicorn main:app --reload

CLI commands:
    python main.py create-key <device-name>
    python main.py list-keys
    python main.py revoke-key <id>
"""

import datetime
import os
import sqlite3
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request

import db
from auth import generate_key, get_current_key, hash_key
from models import (
    BookmarkOut,
    BookmarkSyncRequest,
    BookmarkSyncResponse,
    HealthResponse,
)

load_dotenv()

# ── Rate limiter ────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)

# ── App lifecycle ───────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Initialise the database on startup."""
    db.init_db()
    yield


def create_app() -> FastAPI:
    """Application factory."""
    app = FastAPI(title="Browser Sync", version="0.1.0", lifespan=lifespan)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # CORS — origins from .env, fall back to localhost
    origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in origins],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return app


app = create_app()

# ── Routes ──────────────────────────────────────────────────────


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse()


def parse_datetime_to_ms(dt_str: str | None) -> int | None:
    if not dt_str:
        return None
    try:
        dt = datetime.datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
        return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except Exception:
        return None


@app.get("/api/status")
@limiter.limit("60/minute")
async def get_status(
    request: Request,
    key: sqlite3.Row = Depends(get_current_key),
) -> dict:
    """Return live sync statistics for the authenticated device."""
    stats = db.get_device_stats(key["id"])
    return {
        "bookmarkCount": stats["bookmark_count"],
        "lastBookmarkSync": parse_datetime_to_ms(stats["last_bookmark_sync"]),
    }


@app.put("/api/bookmarks", response_model=BookmarkSyncResponse)
@limiter.limit("60/minute")
async def sync_bookmarks(
    request: Request,
    body: BookmarkSyncRequest,
    key: sqlite3.Row = Depends(get_current_key),
) -> BookmarkSyncResponse:
    """Receive the full bookmark tree and diff server-side."""
    added, updated, deleted = db.upsert_bookmarks(
        key["id"],
        [bm.model_dump() for bm in body.bookmarks],
    )
    return BookmarkSyncResponse(added=added, updated=updated, deleted=deleted)


@app.get("/api/bookmarks", response_model=list[BookmarkOut])
@limiter.limit("60/minute")
async def get_bookmarks(
    request: Request,
    key: sqlite3.Row = Depends(get_current_key),
) -> list[dict]:
    """Return all active bookmarks for the authenticated device."""
    return [dict(row) for row in db.get_bookmarks(key["id"])]





# ── CLI ─────────────────────────────────────────────────────────


def cli() -> None:
    """Minimal CLI for API key management — no extra dependencies."""
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(0)

    # Ensure tables exist before any CLI operation
    db.init_db()

    command = args[0]

    if command == "create-key":
        if len(args) < 2:
            print("Usage: python main.py create-key <device-name>")
            sys.exit(1)
        device_name = args[1]
        raw_key = generate_key()
        key_id = db.insert_api_key(device_name, hash_key(raw_key))
        print(f"✓ Key created for '{device_name}' (id={key_id})")
        print(f"  {raw_key}")
        print("  Save this key — it won't be shown again.")

    elif command == "list-keys":
        keys = db.list_api_keys()
        if not keys:
            print("No API keys found.")
            return
        print(f"{'ID':<5} {'Device':<20} {'Created':<20} {'Status'}")
        print("-" * 70)
        for k in keys:
            status = "revoked" if k["revoked_at"] else "active"
            print(f"{k['id']:<5} {k['device_name']:<20} {k['created_at']:<20} {status}")

    elif command == "revoke-key":
        if len(args) < 2:
            print("Usage: python main.py revoke-key <id>")
            sys.exit(1)
        try:
            key_id = int(args[1])
        except ValueError:
            print("Error: id must be an integer")
            sys.exit(1)
        if db.delete_api_key(key_id):
            print(f"✓ Key {key_id} revoked.")
        else:
            print(f"✗ No key found with id {key_id}.")
            sys.exit(1)

    elif command == "serve":
        _run_server()

    else:
        print(f"Unknown command: {command}")
        print("Available: serve, create-key, list-keys, revoke-key")
        sys.exit(1)


def _run_server() -> None:
    """Start the uvicorn server."""
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "false").lower() == "true",
    )


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("create-key", "list-keys", "revoke-key", "serve"):
        cli()
    else:
        print(__doc__)
        print("Usage: python main.py <command>")
        print("Commands: serve, create-key, list-keys, revoke-key")
        sys.exit(0)

"""Database initialisation, connection helper, and query functions."""

import os
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager

# ── Schema ──────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_name TEXT    NOT NULL,
    key_hash    TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id      INTEGER NOT NULL REFERENCES api_keys(id),
    url         TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    folder_path TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    deleted     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(key_id, url, folder_path)
);

CREATE TABLE IF NOT EXISTS open_tabs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id       INTEGER NOT NULL REFERENCES api_keys(id),
    device_name  TEXT    NOT NULL DEFAULT '',
    url          TEXT    NOT NULL,
    title        TEXT    NOT NULL DEFAULT '',
    fav_icon_url TEXT    NOT NULL DEFAULT '',
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db() -> None:
    """Create tables and apply the small in-place schema migrations."""
    with get_db() as conn:
        conn.executescript(_SCHEMA)
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(api_keys)")}
        if "revoked_at" not in columns:
            conn.execute("ALTER TABLE api_keys ADD COLUMN revoked_at TEXT")

        tab_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(open_tabs)")
        }
        if "device_name" not in tab_columns:
            conn.execute(
                "ALTER TABLE open_tabs ADD COLUMN device_name TEXT NOT NULL DEFAULT ''"
            )


def _restrict_db_permissions() -> None:
    """Keep bookmark data and key hashes readable only by the service account."""
    db_path = os.getenv("DB_PATH", "sync.db")
    for path in (db_path, f"{db_path}-wal", f"{db_path}-shm"):
        try:
            os.chmod(path, 0o600)
        except FileNotFoundError:
            pass


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """Yield a SQLite connection with row factory set, auto-commits on success."""
    db_path = os.getenv("DB_PATH", "sync.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        _restrict_db_permissions()


# ── API key queries ─────────────────────────────────────────────


def insert_api_key(device_name: str, key_hash: str) -> int:
    """Insert a new API key and return its id."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO api_keys (device_name, key_hash) VALUES (?, ?)",
            (device_name, key_hash),
        )
        return cur.lastrowid  # type: ignore[return-value]


def get_key_by_hash(key_hash: str) -> sqlite3.Row | None:
    """Look up an API key row by its hash."""
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
            (key_hash,),
        ).fetchone()


def list_api_keys() -> list[sqlite3.Row]:
    """Return all API keys (without hashes, for CLI display)."""
    with get_db() as conn:
        return conn.execute(
            "SELECT id, device_name, created_at, revoked_at FROM api_keys ORDER BY id"
        ).fetchall()


def delete_api_key(key_id: int) -> bool:
    """Revoke an API key without deleting its associated bookmark data."""
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE api_keys SET revoked_at = datetime('now') "
            "WHERE id = ? AND revoked_at IS NULL",
            (key_id,),
        )
        return cur.rowcount > 0


# ── Bookmark queries ────────────────────────────────────────────


def upsert_bookmarks(
    key_id: int,
    bookmarks: list[dict],
) -> tuple[int, int, int]:
    """
    Sync bookmarks: upsert incoming list, soft-delete any that disappeared.

    Returns (added, updated, deleted) counts.
    """
    added = updated = deleted = 0

    with get_db() as conn:
        # Build a set of (url, folder_path) from incoming data
        incoming = {(b["url"], b["folder_path"]) for b in bookmarks}

        # Fetch current active bookmarks for this device
        existing_rows = conn.execute(
            "SELECT id, url, title, folder_path FROM bookmarks "
            "WHERE key_id = ? AND deleted = 0",
            (key_id,),
        ).fetchall()
        existing = {(r["url"], r["folder_path"]): r for r in existing_rows}

        for bm in bookmarks:
            key = (bm["url"], bm["folder_path"])
            if key in existing:
                # Update title if changed
                row = existing[key]
                if row["title"] != bm["title"]:
                    conn.execute(
                        "UPDATE bookmarks SET title = ?, updated_at = datetime('now') "
                        "WHERE id = ?",
                        (bm["title"], row["id"]),
                    )
                    updated += 1
            else:
                # Insert or un-delete
                conn.execute(
                    "INSERT INTO bookmarks (key_id, url, title, folder_path) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(key_id, url, folder_path) DO UPDATE SET "
                    "deleted = 0, title = excluded.title, updated_at = datetime('now')",
                    (key_id, bm["url"], bm["title"], bm["folder_path"]),
                )
                added += 1

        # Soft-delete bookmarks no longer in the incoming set
        for key, row in existing.items():
            if key not in incoming:
                conn.execute(
                    "UPDATE bookmarks SET deleted = 1, updated_at = datetime('now') "
                    "WHERE id = ?",
                    (row["id"],),
                )
                deleted += 1

    return added, updated, deleted


def get_bookmarks(key_id: int) -> list[sqlite3.Row]:
    """Return all bookmarks for a device, including soft deletes."""
    with get_db() as conn:
        return conn.execute(
            "SELECT id, url, title, folder_path, created_at, updated_at, deleted "
            "FROM bookmarks WHERE key_id = ? "
            "ORDER BY folder_path, title",
            (key_id,),
        ).fetchall()


def get_device_stats(key_id: int) -> dict:
    """Return live sync statistics for the given key_id."""
    with get_db() as conn:
        bookmarks_count = conn.execute(
            "SELECT COUNT(*) FROM bookmarks WHERE key_id = ? AND deleted = 0", (key_id,)
        ).fetchone()[0]

        last_bookmark = conn.execute(
            "SELECT MAX(updated_at) FROM bookmarks WHERE key_id = ? AND deleted = 0",
            (key_id,),
        ).fetchone()[0]

        tabs_count = conn.execute(
            "SELECT COUNT(*) FROM open_tabs WHERE key_id = ?", (key_id,)
        ).fetchone()[0]

        last_tab = conn.execute(
            "SELECT MAX(updated_at) FROM open_tabs WHERE key_id = ?",
            (key_id,),
        ).fetchone()[0]

        return {
            "bookmark_count": bookmarks_count,
            "last_bookmark_sync": last_bookmark,
            "tab_count": tabs_count,
            "last_tab_sync": last_tab,
        }


# ── Open Tab queries ─────────────────────────────────────────────


def replace_open_tabs(key_id: int, device_name: str, tabs: list[dict]) -> None:
    """Replace open tabs for a given device name under this key."""
    with get_db() as conn:
        conn.execute(
            "DELETE FROM open_tabs WHERE key_id = ? AND device_name = ?",
            (key_id, device_name),
        )
        for tab in tabs:
            conn.execute(
                "INSERT INTO open_tabs (key_id, device_name, url, title, fav_icon_url, updated_at) "
                "VALUES (?, ?, ?, ?, ?, datetime('now'))",
                (
                    key_id,
                    device_name,
                    tab["url"],
                    tab["title"],
                    tab.get("fav_icon_url", "") or "",
                ),
            )


def get_other_devices_tabs(current_key_id: int, current_device_name: str) -> list[dict]:
    """Return open tabs grouped by other active devices."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT t.id as tab_id, t.device_name, t.url, t.title, t.fav_icon_url, t.updated_at
            FROM open_tabs t
            JOIN api_keys k ON t.key_id = k.id
            WHERE k.revoked_at IS NULL
              AND NOT (t.key_id = ? AND t.device_name = ?)
            ORDER BY t.device_name, t.id
            """,
            (current_key_id, current_device_name),
        ).fetchall()

        devices_map: dict[str, dict] = {}
        for r in rows:
            dname = r["device_name"]
            if dname not in devices_map:
                devices_map[dname] = {
                    "device_id": dname,
                    "device_name": dname,
                    "tabs": [],
                }
            devices_map[dname]["tabs"].append(
                {
                    "id": r["tab_id"],
                    "url": r["url"],
                    "title": r["title"],
                    "fav_icon_url": r["fav_icon_url"],
                    "updated_at": r["updated_at"],
                }
            )

        return list(devices_map.values())

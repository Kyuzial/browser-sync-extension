"""API key generation, hashing, and FastAPI authentication dependency."""

import hashlib
import secrets
import sqlite3

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from db import get_key_by_hash

_PREFIX = "bsync_"
_bearer = HTTPBearer()


def generate_key() -> str:
    """Generate a new API key: bsync_<32 hex chars>."""
    return f"{_PREFIX}{secrets.token_hex(16)}"


def hash_key(raw_key: str) -> str:
    """SHA-256 hash a raw API key for storage."""
    return hashlib.sha256(raw_key.encode()).hexdigest()


async def get_current_key(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> sqlite3.Row:
    """
    FastAPI dependency that validates the Bearer token against stored hashes.
    Returns the api_keys row on success, raises 401 otherwise.
    """
    token = credentials.credentials
    if not token.startswith(_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key format",
        )

    row = get_key_by_hash(hash_key(token))
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked API key",
        )
    return row

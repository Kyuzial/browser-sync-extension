"""Pydantic models for request/response validation."""

from pydantic import BaseModel, Field


# ── Request models ──────────────────────────────────────────────

class BookmarkIn(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    title: str = Field("", max_length=512)
    folder_path: str = Field("", max_length=1024, description="e.g. 'Bookmarks Bar/Recipes'")


class BookmarkSyncRequest(BaseModel):
    bookmarks: list[BookmarkIn] = Field(..., max_length=10_000)


# ── Response models ─────────────────────────────────────────────

class BookmarkOut(BaseModel):
    id: int
    url: str
    title: str
    folder_path: str
    created_at: str
    updated_at: str
    deleted: bool


class BookmarkSyncResponse(BaseModel):
    added: int
    updated: int
    deleted: int


class HealthResponse(BaseModel):
    status: str = "ok"

"""Pydantic models for request/response validation."""

from pydantic import BaseModel, Field


# ── Request models ──────────────────────────────────────────────


class BookmarkIn(BaseModel):
    url: str = Field(..., min_length=1, max_length=65_536)
    title: str = Field("", max_length=512)
    folder_path: str = Field(
        "", max_length=1024, description="e.g. 'Bookmarks Bar/Recipes'"
    )


class BookmarkSyncRequest(BaseModel):
    bookmarks: list[BookmarkIn] = Field(..., max_length=10_000)


class TabIn(BaseModel):
    url: str = Field(..., min_length=1, max_length=65_536)
    title: str = Field("", max_length=512)
    fav_icon_url: str = Field("", max_length=65_536)


class TabSyncRequest(BaseModel):
    tabs: list[TabIn] = Field(..., max_length=1_000)


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


class TabOut(BaseModel):
    id: int
    url: str
    title: str
    fav_icon_url: str
    updated_at: str


class DeviceTabsOut(BaseModel):
    device_id: str
    device_name: str
    tabs: list[TabOut]


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "1.1.0"

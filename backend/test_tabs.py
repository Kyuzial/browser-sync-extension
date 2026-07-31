"""Unit tests for open tabs sync functionality."""

import pytest
from fastapi.testclient import TestClient

import db
from auth import generate_key, hash_key
from main import app


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    """Use a temporary database file for testing."""
    test_db_path = str(tmp_path / "test_sync.db")
    monkeypatch.setenv("DB_PATH", test_db_path)
    db.init_db()


def test_db_replace_and_get_other_tabs():
    key1_raw = generate_key()
    key2_raw = generate_key()

    id1 = db.insert_api_key("Device 1 - Firefox", hash_key(key1_raw))
    id2 = db.insert_api_key("Device 2 - Chrome", hash_key(key2_raw))

    # Insert open tabs for device 1
    db.replace_open_tabs(
        id1,
        [
            {"url": "https://example.com/1", "title": "Example 1", "fav_icon_url": "https://example.com/favicon.ico"},
            {"url": "https://example.com/2", "title": "Example 2", "fav_icon_url": ""},
        ],
    )

    # Insert open tabs for device 2
    db.replace_open_tabs(
        id2,
        [
            {"url": "https://github.com", "title": "GitHub", "fav_icon_url": "https://github.com/favicon.ico"},
        ],
    )

    # Device 1 queries other devices' tabs
    other_tabs_for_1 = db.get_other_devices_tabs(id1)
    assert len(other_tabs_for_1) == 1
    assert other_tabs_for_1[0]["device_name"] == "Device 2 - Chrome"
    assert len(other_tabs_for_1[0]["tabs"]) == 1
    assert other_tabs_for_1[0]["tabs"][0]["url"] == "https://github.com"

    # Device 2 queries other devices' tabs
    other_tabs_for_2 = db.get_other_devices_tabs(id2)
    assert len(other_tabs_for_2) == 1
    assert other_tabs_for_2[0]["device_name"] == "Device 1 - Firefox"
    assert len(other_tabs_for_2[0]["tabs"]) == 2


def test_api_tabs_endpoints():
    client = TestClient(app)

    raw_key1 = generate_key()
    raw_key2 = generate_key()

    db.insert_api_key("Laptop", hash_key(raw_key1))
    db.insert_api_key("Desktop", hash_key(raw_key2))

    headers1 = {"Authorization": f"Bearer {raw_key1}"}
    headers2 = {"Authorization": f"Bearer {raw_key2}"}

    # Upload tabs from Laptop
    payload = {
        "tabs": [
            {"url": "https://python.org", "title": "Python", "fav_icon_url": ""},
            {"url": "https://fastapi.tiangolo.com", "title": "FastAPI", "fav_icon_url": ""},
        ]
    }
    res = client.put("/api/tabs", json=payload, headers=headers1)
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "count": 2}

    # Fetch other tabs from Desktop
    res_other = client.get("/api/tabs/other", headers=headers2)
    assert res_other.status_code == 200
    data = res_other.json()
    assert len(data) == 1
    assert data[0]["device_name"] == "Laptop"
    assert len(data[0]["tabs"]) == 2
    titles = [t["title"] for t in data[0]["tabs"]]
    assert "Python" in titles
    assert "FastAPI" in titles

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
        "dev_ff",
        "Device 1 - Firefox",
        [
            {
                "url": "https://example.com/1",
                "title": "Example 1",
                "fav_icon_url": "https://example.com/favicon.ico",
            },
            {"url": "https://example.com/2", "title": "Example 2", "fav_icon_url": ""},
        ],
    )

    # Insert open tabs for device 2
    db.replace_open_tabs(
        id2,
        "dev_ch",
        "Device 2 - Chrome",
        [
            {
                "url": "https://github.com",
                "title": "GitHub",
                "fav_icon_url": "https://github.com/favicon.ico",
            },
        ],
    )

    # Device 1 queries other devices' tabs
    other_tabs_for_1 = db.get_other_devices_tabs(id1, "dev_ff", "Device 1 - Firefox")
    assert len(other_tabs_for_1) == 1
    assert other_tabs_for_1[0]["device_name"] == "Device 2 - Chrome"
    assert len(other_tabs_for_1[0]["tabs"]) == 1
    assert other_tabs_for_1[0]["tabs"][0]["url"] == "https://github.com"

    # Device 2 queries other devices' tabs
    other_tabs_for_2 = db.get_other_devices_tabs(id2, "dev_ch", "Device 2 - Chrome")
    assert len(other_tabs_for_2) == 1
    assert other_tabs_for_2[0]["device_name"] == "Device 1 - Firefox"
    assert len(other_tabs_for_2[0]["tabs"]) == 2


def test_api_tabs_endpoints_with_shared_key():
    client = TestClient(app)

    raw_key = generate_key()
    db.insert_api_key("Shared Key Device", hash_key(raw_key))

    # Two browsers using the SAME API key but specifying different device names
    headers_firefox = {
        "Authorization": f"Bearer {raw_key}",
        "X-Device-Name": "Firefox on Linux",
    }
    headers_chrome = {
        "Authorization": f"Bearer {raw_key}",
        "X-Device-Name": "Chrome on Linux",
    }

    # Upload tabs from Firefox (2 tabs)
    payload_firefox = {
        "tabs": [
            {"url": "https://python.org", "title": "Python", "fav_icon_url": ""},
            {
                "url": "https://fastapi.tiangolo.com",
                "title": "FastAPI",
                "fav_icon_url": "",
            },
        ]
    }
    res1 = client.put("/api/tabs", json=payload_firefox, headers=headers_firefox)
    assert res1.status_code == 200

    # Upload tabs from Chrome (0 tabs)
    payload_chrome = {"tabs": []}
    res2 = client.put("/api/tabs", json=payload_chrome, headers=headers_chrome)
    assert res2.status_code == 200

    # Chrome queries other tabs -> should see Firefox's 2 tabs!
    res_other = client.get("/api/tabs/other", headers=headers_chrome)
    assert res_other.status_code == 200
    data = res_other.json()
    assert len(data) == 1
    assert data[0]["device_name"] == "Firefox on Linux"
    assert len(data[0]["tabs"]) == 2

    # Firefox queries other tabs -> Chrome has 0 tabs, so 0 devices with tabs returned
    res_other_ff = client.get("/api/tabs/other", headers=headers_firefox)
    assert res_other_ff.status_code == 200
    data_ff = res_other_ff.json()
    assert len(data_ff) == 0

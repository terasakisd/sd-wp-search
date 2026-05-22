"""Supabase版 DB 層。既存の db.py と同じインタフェースを提供する。

GitHub Actions などからクローラを動かすときに、SQLite ではなく Supabase に
書き込むために使う。FastAPI 側の検索ロジックは Supabase RPC を直接呼ぶので
このモジュールは書き込み専用。

環境変数:
    SUPABASE_URL          - https://xxxxx.supabase.co
    SUPABASE_SERVICE_KEY  - service_role の secret key (書き込み権限あり)
"""
from __future__ import annotations

import os
import re
import unicodedata
from typing import Any

from supabase import Client, create_client


_SB: Client | None = None


def _client() -> Client:
    global _SB
    if _SB is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        _SB = create_client(url, key)
    return _SB


# ----- トークン化 (db.py から移植) ------------------------------------------

def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3040 <= code <= 0x30FF
        or 0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF66 <= code <= 0xFF9F
    )


def tokenize_for_index(text: str) -> str:
    """インデックス用に、日本語文字の前後に空白を入れる。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    out: list[str] = []
    prev_cjk = False
    prev_space = True
    for ch in text:
        if ch.isspace():
            out.append(" ")
            prev_cjk = False
            prev_space = True
            continue
        if _is_cjk(ch):
            if not prev_space:
                out.append(" ")
            out.append(ch)
            out.append(" ")
            prev_cjk = True
            prev_space = True
        else:
            if not (ch.isalnum() or ch in "_-.@/"):
                out.append(" ")
                prev_space = True
                prev_cjk = False
                continue
            if prev_cjk and not prev_space:
                out.append(" ")
            out.append(ch.lower())
            prev_cjk = False
            prev_space = False
    return " ".join("".join(out).split())


# ----- ノーオペ関数 (FastAPI 互換) ------------------------------------------

def init_db() -> None:
    """Supabaseではスキーマは SQL Editor で別途作成済み。何もしない。"""
    pass


# ----- サイト操作 -----------------------------------------------------------

def upsert_site(site_id: str, name: str, url: str, group_id: str = "backlink") -> None:
    _client().table("sites").upsert(
        {"id": site_id, "name": name, "url": url, "group_id": group_id},
        on_conflict="id",
    ).execute()


def update_site_crawl_state(
    site_id: str, last_crawled_at: str, last_modified: str | None
) -> None:
    payload: dict[str, Any] = {"last_crawled_at": last_crawled_at}
    if last_modified is not None:
        payload["last_modified"] = last_modified
    _client().table("sites").update(payload).eq("id", site_id).execute()


def get_site(site_id: str) -> dict | None:
    res = (
        _client().table("sites").select("*").eq("id", site_id).limit(1).execute()
    )
    return res.data[0] if res.data else None


def list_sites() -> list[dict]:
    res = _client().table("sites").select("*").order("name").execute()
    return res.data or []


def reset_site_modified_state(site_id: str) -> None:
    _client().table("sites").update({"last_modified": None}).eq("id", site_id).execute()


def reset_all_modified_state() -> None:
    # PostgREST は全件 UPDATE に WHERE 条件を要求するので、ありえない条件で全件指定
    _client().table("sites").update({"last_modified": None}).not_.is_("id", None).execute()


# ----- 記事操作 -------------------------------------------------------------

def upsert_post(post: dict[str, Any]) -> None:
    p = dict(post)
    # PostgreSQL の生成カラム fts は送らない (送ると弾かれる)
    # *_idx は Pythonで生成して送る
    p["title_idx"] = tokenize_for_index(p.get("title") or "")
    p["excerpt_idx"] = tokenize_for_index(p.get("excerpt") or "")
    p["content_idx"] = tokenize_for_index(p.get("content") or "")

    # post_id は BIGINT 想定 (URLハッシュ由来のスクレイピング値も収まる)
    if p.get("post_id") is not None:
        p["post_id"] = int(p["post_id"])

    # 空文字の categories/tags は NULL に統一 (任意)
    if not p.get("categories"):
        p["categories"] = None
    if not p.get("tags"):
        p["tags"] = None

    _client().table("posts").upsert(p, on_conflict="site_id,post_id").execute()


# ----- 件数取得 (動作確認用) ------------------------------------------------

def count_posts() -> int:
    res = _client().table("posts").select("id", count="exact").limit(1).execute()
    return res.count or 0


def count_posts_by_site() -> dict[str, int]:
    # PostgreSQL の group by は RPC 経由が便利だが、ここでは簡易実装
    res = _client().table("posts").select("site_id").execute()
    counts: dict[str, int] = {}
    for row in res.data or []:
        sid = row["site_id"]
        counts[sid] = counts.get(sid, 0) + 1
    return counts

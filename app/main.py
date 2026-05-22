"""FastAPI アプリケーション。検索API + UI配信 + クロール手動トリガー。"""
from __future__ import annotations

import asyncio
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from . import db
from .crawler import crawl_all, load_config

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="WP Multi-Site Search")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

scheduler: AsyncIOScheduler | None = None
_crawl_lock = asyncio.Lock()
_crawl_status: dict = {"running": False, "last_result": None}


@app.on_event("startup")
async def on_startup() -> None:
    db.init_db()
    # 設定ファイルからサイトを登録
    config = load_config() or {}
    for s in (config.get("sites") or []):
        db.upsert_site(
            s["id"],
            s["name"],
            s["url"].rstrip("/"),
            s.get("group") or "backlink",
        )

    # 定期クロールのスケジューラ起動
    global scheduler
    hours = (config.get("crawl") or {}).get("schedule_hours", 6)
    scheduler = AsyncIOScheduler()
    scheduler.add_job(_scheduled_crawl, "interval", hours=hours, id="periodic_crawl")
    scheduler.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    if scheduler:
        scheduler.shutdown(wait=False)


async def _scheduled_crawl() -> None:
    if _crawl_status["running"]:
        return
    async with _crawl_lock:
        _crawl_status["running"] = True
        try:
            result = await crawl_all()
            _crawl_status["last_result"] = result
        finally:
            _crawl_status["running"] = False


# ----- ルート ----------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/search")
async def search(
    q: str = "",
    site: list[str] = Query(default=[]),
    group: str | None = None,
    category: list[str] = Query(default=[]),
    tag: list[str] = Query(default=[]),
    sort: str = "relevance",
    limit: int = 30,
    offset: int = 0,
):
    results, total = db.search_posts(
        q,
        site_ids=site or None,
        group_id=group,
        categories=category or None,
        tags=tag or None,
        sort=sort,
        limit=max(1, min(limit, 100)),
        offset=max(0, offset),
    )
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": results,
    }


@app.get("/api/facets")
async def facets():
    return db.get_facets()


@app.get("/api/groups")
async def groups():
    config = load_config() or {}
    return {"groups": config.get("groups") or [{"id": "backlink", "name": "サイト"}]}


@app.get("/api/stats")
async def stats():
    return {
        "total_posts": db.count_posts(),
        "posts_by_site": db.count_posts_by_site(),
        "sites": [dict(s) for s in db.list_sites()],
        "crawl_status": _crawl_status,
    }


@app.post("/api/crawl")
async def trigger_crawl(site_id: str | None = None, full: bool = False):
    """クロール開始。full=true で last_modified をクリアし強制全件取り直し。"""
    if _crawl_status["running"]:
        return JSONResponse(
            {"ok": False, "message": "クロールは既に実行中です"}, status_code=409
        )

    if full:
        # 対象サイトの last_modified をクリア → modified_after が外れて全件取り直しになる
        if site_id:
            db.reset_site_modified_state(site_id)
        else:
            db.reset_all_modified_state()

    async def runner():
        async with _crawl_lock:
            _crawl_status["running"] = True
            try:
                only = [site_id] if site_id else None
                _crawl_status["last_result"] = await crawl_all(only_site_ids=only)
            finally:
                _crawl_status["running"] = False

    asyncio.create_task(runner())
    return {
        "ok": True,
        "message": "クロールを開始しました" + (" (全件取り直し)" if full else ""),
    }

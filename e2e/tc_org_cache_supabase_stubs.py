"""
Playwright route handlers for Supabase REST + org sync Edge Function used by script.js
after login (cached_autotask_companies, autotask_org_sync_meta, autotask-sync-all-companies).
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple


def _cors_for_request(request) -> Tuple[Dict[str, str], str]:
    origin = (request.headers.get("origin") or "").strip()
    allow_origin = origin if origin else "*"
    acrh = (request.headers.get("access-control-request-headers") or "").strip()
    allow_headers = (
        acrh if acrh else "authorization, apikey, content-type, x-client-info, prefer, range, accept-profile"
    )
    base_cors = {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
        "Access-Control-Allow-Headers": allow_headers,
        "Access-Control-Max-Age": "86400",
    }
    return base_cors, allow_origin


async def _fulfill_json(route, body: Any, status: int = 200) -> None:
    req = route.request
    base_cors, _ = _cors_for_request(req)
    if req.method.upper() == "OPTIONS":
        await route.fulfill(status=204, headers=base_cors)
        return
    headers = {
        **base_cors,
        "Content-Type": "application/json; charset=utf-8",
    }
    await route.fulfill(status=status, headers=headers, body=json.dumps(body))


async def register_org_cache_supabase_stubs(page, company_rows: List[Dict[str, str]]) -> str:
    """
    Stubs PostgREST reads and optional full-sync Edge call.
    company_rows: items with keys autotask_id, company_name.
    Returns last_full_sync_at ISO string used in meta (recent = skip weekly sync).
    """
    meta_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    meta_rows = [{"id": 1, "last_full_sync_at": meta_ts, "full_sync_started_at": None}]

    async def fulfill_companies(route):
        await _fulfill_json(route, company_rows)

    async def fulfill_meta(route):
        await _fulfill_json(route, meta_rows)

    async def fulfill_sync(route):
        await _fulfill_json(route, {"skipped": True, "last_full_sync_at": meta_ts})

    await page.route("**/rest/v1/cached_autotask_companies**", fulfill_companies)
    await page.route("**/rest/v1/autotask_org_sync_meta**", fulfill_meta)
    await page.route("**/functions/v1/autotask-sync-all-companies**", fulfill_sync)
    return meta_ts

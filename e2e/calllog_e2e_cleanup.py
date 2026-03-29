"""
Remove Supabase rows created by Playwright E2E tests.

Each test run uses a unique id embedded in the call `notes` field so cleanup is targeted
and safe when multiple tests run in parallel against the same test account.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone

E2E_MARKER = "calllog-e2e-automation"
E2E_RUN_KEY = "e2e-run="


def new_e2e_run_id() -> str:
    """Unique id per test; prefixed with CALLLOG_TEST_RUN_ID in CI for traceability."""
    ci = (os.environ.get("CALLLOG_TEST_RUN_ID") or "").strip()
    u = uuid.uuid4().hex
    return f"{ci}-{u}" if ci else u


def e2e_notes_with_run_id(run_id: str, human_note: str = "") -> str:
    suffix = f"{E2E_MARKER} {E2E_RUN_KEY}{run_id}"
    human = human_note.strip()
    if human:
        return f"{human} | {suffix}"
    return suffix


def _supabase_client_from_env():
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_ANON_KEY") or "").strip()
    email = (os.environ.get("CALLLOG_TEST_EMAIL") or "").strip()
    password = (os.environ.get("CALLLOG_TEST_PASSWORD") or "").strip()
    if not (url and key and email and password):
        return None
    from supabase import create_client

    return create_client(url, key), email, password


def cleanup_e2e_calls_for_run_id(run_id: str) -> None:
    if not run_id:
        return
    pack = _supabase_client_from_env()
    if pack is None:
        return
    client, email, password = pack
    client.auth.sign_in_with_password({"email": email, "password": password})
    pattern = f"%{E2E_RUN_KEY}{run_id}%"
    client.table("calls").delete().like("notes", pattern).execute()


def reset_profile_full_name_to_email_local_part() -> None:
    pack = _supabase_client_from_env()
    if pack is None:
        return
    client, email, password = pack
    client.auth.sign_in_with_password({"email": email, "password": password})
    session = client.auth.get_session()
    if session is None or session.user is None:
        return
    uid = session.user.id
    local = email.split("@", 1)[0].strip() if "@" in email else email
    if not local:
        local = "User"
    client.table("profiles").upsert(
        {
            "id": uid,
            "full_name": local,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    ).execute()


def run_supabase_e2e_cleanup(
    *,
    e2e_run_id: str | None = None,
    reset_profile_full_name: bool = False,
) -> None:
    try:
        if e2e_run_id:
            cleanup_e2e_calls_for_run_id(e2e_run_id)
        if reset_profile_full_name:
            reset_profile_full_name_to_email_local_part()
    except Exception as exc:
        print(f"E2E Supabase cleanup warning: {exc}", file=sys.stderr)

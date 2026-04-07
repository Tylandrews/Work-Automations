"""
Load local E2E secrets from e2e/.env (gitignored).

Does not override variables already set in the process environment (CI wins).
TC*.py pick up values via os.environ after tc_browser imports this module.
"""
from __future__ import annotations

import os
from pathlib import Path

_LOADED = False


def load_e2e_dotenv() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, rest = line.partition("=")
        key = key.strip()
        if not key:
            continue
        val = rest.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        if key not in os.environ:
            os.environ[key] = val

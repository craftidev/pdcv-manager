from __future__ import annotations

import argparse
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .db import Store

ROOT = Path(__file__).resolve().parents[1]


def database_url():
    value = os.environ.get("DATABASE_URL", f"sqlite:///{ROOT / 'data/client-review.sqlite'}")
    if os.environ.get("DYNO") and value.startswith("sqlite:"):
        raise ValueError("Heroku requires a persistent DATABASE_URL; local SQLite is only for development")
    return value


def main():
    parser = argparse.ArgumentParser(description="Initialize or explicitly reset the client review database.")
    parser.add_argument("action", choices=["init", "reset"])
    parser.add_argument("--dataset", type=Path, default=Path(__file__).with_name("dataset.json"))
    parser.add_argument("--confirm-reset", action="store_true", help="Erase test progress and restore initial classifications")
    parser.add_argument("--backup", type=Path, help="Write the pre-reset export here (default: data/reset-backups/ timestamped JSON)")
    args = parser.parse_args()
    if args.action == "reset" and not args.confirm_reset:
        parser.error("Reset clears ALL reviewer decisions and history. Close reviewer tabs, then use --confirm-reset.")
    store = Store(database_url())
    try:
        dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
        if args.action == "init":
            store.initialize(dataset)
            print("Client review database ready. Existing decisions retained.")
        else:
            if store.dataset["version"] != dataset["version"]:
                raise ValueError("Database and supplied dataset differ. Nothing was reset.")
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = args.backup or ROOT / "data/reset-backups" / f"{stamp}-{uuid.uuid4().hex[:8]}.json"
            backup.parent.mkdir(parents=True, exist_ok=True)
            with backup.open("x", encoding="utf-8") as handle:
                json.dump(store.export(), handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            store.reset_to_initial()
            print(f"Pre-reset export: {backup.resolve()}")
            print("Review progress reset. Initial classifications restored, all automatic results unverified, history cleared.")
            print("Reload reviewer tabs before continuing. On Heroku, download your app export before resetting; local backup files are temporary.")
    finally:
        store.engine.dispose()


if __name__ == "__main__":
    main()

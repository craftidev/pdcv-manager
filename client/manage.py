from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .db import Store

ROOT = Path(__file__).resolve().parents[1]


def database_url():
    value = os.environ.get(
        "DATABASE_URL", f"sqlite:///{ROOT / 'data/client-review.sqlite'}"
    )
    if os.environ.get("DYNO") and value.startswith("sqlite:"):
        raise ValueError(
            "Heroku requires a persistent DATABASE_URL; local SQLite is only for development"
        )
    return value


def main():
    parser = argparse.ArgumentParser(
        description="Initialize the client review database without overwriting existing decisions."
    )
    parser.add_argument("action", choices=["init"])
    parser.add_argument(
        "--dataset", type=Path, default=Path(__file__).with_name("dataset.json")
    )
    args = parser.parse_args()
    store = Store(database_url())
    store.initialize(json.loads(args.dataset.read_text(encoding="utf-8")))
    print("Client review database ready. Existing decisions retained.")


if __name__ == "__main__":
    main()

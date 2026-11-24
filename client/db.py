from __future__ import annotations

import time
from pathlib import Path

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
    insert,
    or_,
    select,
    update,
)

from .rules import exclusion

metadata = MetaData()
datasets = Table(
    "pdcv_dataset",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("version", String(64), nullable=False),
    Column("payload", JSON, nullable=False),
)
decisions = Table(
    "pdcv_decision",
    metadata,
    Column("key", String(64), primary_key=True),
    Column("category", String(16)),
    Column("origin", String(16), nullable=False),
    Column("verified", Boolean, nullable=False),
    Column("skipped", Boolean, nullable=False),
    Column("conflict", Boolean, nullable=False),
    Column("evidence", JSON, nullable=False),
    Column("version", Integer, nullable=False),
    Column("actor_name", String(100), nullable=False),
    Column("lease_owner", String(64)),
    Column("lease_name", String(100)),
    Column("lease_until", Float),
    Column("updated_at", Float, nullable=False),
)
events = Table(
    "pdcv_event",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("key", String(64), nullable=False),
    Column("actor_id", String(64), nullable=False),
    Column("actor_name", String(100), nullable=False),
    Column("action", String(16), nullable=False),
    Column("before", JSON, nullable=False),
    Column("after", JSON, nullable=False),
    Column("at", Float, nullable=False),
)
FIELDS = ("category", "origin", "verified", "skipped", "conflict", "actor_name")


class Conflict(Exception):
    pass


class Store:
    def __init__(self, url: str):
        if url.startswith("postgres://"):
            url = "postgresql+psycopg://" + url[len("postgres://") :]
        elif url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://") :]
        if url.startswith("sqlite:///"):
            path = url[len("sqlite:///") :]
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
        options = (
            {"connect_args": {"timeout": 15, "check_same_thread": False}}
            if url.startswith("sqlite:")
            else {"pool_size": 3, "max_overflow": 1, "pool_timeout": 15}
        )
        self.engine = create_engine(url, pool_pre_ping=True, **options)
        self._dataset = None

    def initialize(self, dataset: dict):
        metadata.create_all(self.engine)
        with self.engine.begin() as connection:
            existing = connection.execute(select(datasets)).mappings().first()
            if existing:
                if existing["version"] != dataset["version"]:
                    raise ValueError(
                        "This database contains another dataset. Existing decisions were not changed."
                    )
                return
            connection.execute(
                insert(datasets),
                {"id": 1, "version": dataset["version"], "payload": dataset},
            )
            connection.execute(
                insert(decisions),
                [
                    {
                        "key": key,
                        "category": row["decision"]["category"],
                        "origin": row["decision"]["origin"],
                        "verified": False,
                        "skipped": False,
                        "conflict": row["decision"]["conflict"],
                        "evidence": row["decision"]["evidence"],
                        "version": 0,
                        "actor_name": "",
                        "lease_owner": None,
                        "lease_name": None,
                        "lease_until": None,
                        "updated_at": time.time(),
                    }
                    for key, row in dataset["destinations"].items()
                ],
            )

    @property
    def dataset(self):
        if self._dataset is None:
            with self.engine.connect() as connection:
                self._dataset = connection.execute(
                    select(datasets.c.payload).where(datasets.c.id == 1)
                ).scalar_one()
        return self._dataset

    def snapshot(self, actor_id=""):
        with self.engine.connect() as connection:
            rows = connection.execute(select(decisions)).mappings().all()
        now = time.time()
        result = {}
        for value in rows:
            row = dict(value)
            row["mine"] = row.pop("lease_owner") == actor_id
            row["busy"] = bool(
                row["lease_until"] and row["lease_until"] > now and not row["mine"]
            )
            if not row["busy"] and not row["mine"]:
                row["lease_name"] = None
            result[row["key"]] = row
        return result

    def claim(self, key, actor_id, name):
        if key not in self.dataset["destinations"]:
            raise ValueError("Lien inconnu.")
        now = time.time()
        available = or_(
            decisions.c.lease_owner == actor_id,
            decisions.c.lease_owner.is_(None),
            decisions.c.lease_until < now,
        )
        with self.engine.begin() as connection:
            result = connection.execute(
                update(decisions)
                .where(decisions.c.key == key, available)
                .values(lease_owner=actor_id, lease_name=name, lease_until=now + 120)
            )
            if result.rowcount != 1:
                raise Conflict(
                    "Ce lien est en cours de lecture par une autre personne."
                )
            connection.execute(
                update(decisions)
                .where(decisions.c.lease_owner == actor_id, decisions.c.key != key)
                .values(lease_owner=None, lease_name=None, lease_until=None)
            )

    def release(self, key, actor_id):
        with self.engine.begin() as connection:
            connection.execute(
                update(decisions)
                .where(decisions.c.key == key, decisions.c.lease_owner == actor_id)
                .values(lease_owner=None, lease_name=None, lease_until=None)
            )

    def release_actor(self, actor_id):
        with self.engine.begin() as connection:
            connection.execute(
                update(decisions)
                .where(decisions.c.lease_owner == actor_id)
                .values(lease_owner=None, lease_name=None, lease_until=None)
            )

    def renew(self, key, actor_id):
        with self.engine.begin() as connection:
            result = connection.execute(
                update(decisions)
                .where(decisions.c.key == key, decisions.c.lease_owner == actor_id)
                .values(lease_until=time.time() + 120)
            )
            if result.rowcount != 1:
                raise Conflict("Ce lien n’est plus réservé pour votre session.")

    def change(
        self, key, version, action, actor_id, name, category=None, event_id=None
    ):
        if key not in self.dataset["destinations"] or not isinstance(version, int):
            raise ValueError("Lien ou version invalide.")
        with self.engine.begin() as connection:
            old = (
                connection.execute(select(decisions).where(decisions.c.key == key))
                .mappings()
                .one()
            )
            if old["version"] != version:
                raise Conflict(
                    "Ce choix a changé depuis son affichage. Le dernier choix a été rechargé."
                )
            now = time.time()
            before = {field: old[field] for field in FIELDS}
            after = dict(before)
            if action == "decide":
                if category not in {"service", "relais", "ignore"}:
                    raise ValueError("Choisissez service, relais ou sans ID.")
                if (
                    exclusion(self.dataset["destinations"][key]["url"])
                    and category != "ignore"
                ):
                    raise ValueError(
                        "Les liens internes, email et téléphone restent sans ID."
                    )
                after.update(
                    category=category,
                    origin="manual",
                    verified=True,
                    skipped=False,
                    conflict=False,
                    actor_name=name,
                )
            elif action == "verify":
                if old["origin"] != "auto" or old["category"] is None:
                    raise ValueError(
                        "Ce lien n’a pas de classement automatique à vérifier."
                    )
                after.update(verified=True, actor_name=name, skipped=False)
            elif action == "skip":
                if old["category"] is not None and old["verified"]:
                    raise ValueError(
                        "Ce lien est déjà traité. Vous pouvez modifier son choix ou consulter le suivant."
                    )
                after.update(skipped=True, actor_name=name)
            elif action == "undo":
                event = (
                    connection.execute(
                        select(events).where(
                            events.c.id == event_id,
                            events.c.key == key,
                            events.c.actor_id == actor_id,
                        )
                    )
                    .mappings()
                    .first()
                )
                if not event or event["after"].get("version") != version:
                    raise Conflict(
                        "Cette action ne peut plus être annulée : une modification plus récente existe."
                    )
                after = {field: event["before"][field] for field in FIELDS}
            else:
                raise ValueError("Action inconnue.")
            available = or_(
                decisions.c.lease_owner == actor_id,
                decisions.c.lease_owner.is_(None),
                decisions.c.lease_until < now,
            )
            result = connection.execute(
                update(decisions)
                .where(
                    decisions.c.key == key, decisions.c.version == version, available
                )
                .values(
                    **after,
                    version=version + 1,
                    updated_at=now,
                    lease_owner=None,
                    lease_name=None,
                    lease_until=None,
                )
            )
            if result.rowcount != 1:
                raise Conflict(
                    "Ce lien est en cours de modification par une autre personne. Rechargez le dernier choix."
                )
            event = connection.execute(
                insert(events),
                {
                    "key": key,
                    "actor_id": actor_id,
                    "actor_name": name,
                    "action": action,
                    "before": {**before, "version": version},
                    "after": {**after, "version": version + 1},
                    "at": now,
                },
            )
            return event.inserted_primary_key[0]

    def history(self, key):
        with self.engine.connect() as connection:
            return [
                {
                    field: row[field]
                    for field in ("id", "actor_name", "action", "before", "after", "at")
                }
                for row in connection.execute(
                    select(events)
                    .where(events.c.key == key)
                    .order_by(events.c.id.desc())
                ).mappings()
            ]

    def export(self):
        rows = self.snapshot()
        occurrences = []
        for key, source in self.dataset["destinations"].items():
            decision = rows[key]
            for original in source["occurrences"]:
                category = decision["category"]
                final_id = None
                if (
                    category in {"service", "relais"}
                    and not original["integration_hold"]
                    and not exclusion(source["url"])
                ):
                    final_id = (
                        ("services" if category == "service" else "relais")
                        + "_region_"
                        + original["region_code"]
                    )
                occurrences.append(
                    {
                        **original,
                        "category": category,
                        "id_to_apply": final_id,
                        "origin": decision["origin"],
                        "verified": decision["verified"],
                        "version": decision["version"],
                    }
                )
        pending = sum(
            row["category"] is None or not row["verified"] for row in rows.values()
        )
        with self.engine.connect() as connection:
            history = [
                {key: value for key, value in row.items() if key != "actor_id"}
                for row in connection.execute(
                    select(events).order_by(events.c.id)
                ).mappings()
                if row["after"]["version"] <= rows[row["key"]]["version"]
            ]
        return {
            "schema_version": 1,
            "dataset_version": self.dataset["version"],
            "source_inventory_sha256": self.dataset["source_inventory_sha256"],
            "precheck_revision": self.dataset["precheck_revision"],
            "pending_destinations": pending,
            "ready_for_integration": pending == 0,
            "decisions": {
                key: {
                    field: row[field]
                    for field in (*FIELDS, "key", "version", "evidence", "updated_at")
                }
                for key, row in rows.items()
            },
            "occurrences": occurrences,
            "history": history,
        }

from __future__ import annotations

import argparse
import json
import os
import secrets
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, redirect, request, send_file, session
from sqlalchemy.exc import OperationalError
from werkzeug.middleware.proxy_fix import ProxyFix

from .db import Conflict, Store
from .manage import database_url

ROOT = Path(__file__).resolve().parents[1]


def create_app(config=None):
    app = Flask(__name__, static_folder="static", static_url_path="/assets")
    hosted = bool(os.environ.get("DYNO"))
    secret = os.environ.get("SECRET_KEY")
    code = os.environ.get("PDCV_ACCESS_CODE", "")
    if hosted and (not secret or not code):
        raise ValueError("Set SECRET_KEY and PDCV_ACCESS_CODE before deploying")
    app.config.update(
        SECRET_KEY=secret or secrets.token_hex(32),
        ACCESS_CODE=code,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=hosted,
        MAX_CONTENT_LENGTH=1_000_000,
    )
    if config:
        app.config.update(config)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1)
    store = app.config.get("STORE") or Store(database_url())
    store.dataset
    app.extensions["review_store"] = store

    @app.before_request
    def gate():
        if hosted and request.scheme != "https":
            return redirect(request.url.replace("http://", "https://", 1), code=308)
        if request.method == "POST":
            origin = request.headers.get("Origin")
            if origin and urlsplit(origin).netloc != request.host:
                return jsonify(error="Origine refusée."), 403
            if not request.is_json:
                return jsonify(error="Requête JSON attendue."), 400
            if not isinstance(request.get_json(), dict):
                return jsonify(error="Objet JSON attendu."), 400
        if request.path.startswith("/api/") and request.path not in {
            "/api/session",
            "/api/login",
        }:
            if not session.get("reviewer_id"):
                return jsonify(error="Identifiez-vous pour commencer."), 401
            if request.method == "POST" and not secrets.compare_digest(
                request.headers.get("X-CSRF-Token", ""), session.get("csrf", "")
            ):
                return jsonify(error="Session à recharger."), 403

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src https: http: data:; style-src 'self'; script-src 'self'; frame-src 'none'; base-uri 'none'"
        )
        return response

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(Conflict)
    def changed(error):
        return jsonify(
            error=str(error), decisions=store.snapshot(session.get("reviewer_id", ""))
        ), 409

    @app.errorhandler(OperationalError)
    def database_busy(_):
        return jsonify(
            error="Enregistrement temporairement indisponible. Réessayez ; votre choix affiché est conservé."
        ), 503

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/shared/context-view.js")
    def shared_context():
        return send_file(
            ROOT / "review/static/context-view.js", mimetype="text/javascript"
        )

    @app.get("/api/session")
    def who():
        return jsonify(
            authenticated=bool(session.get("reviewer_id")),
            name=session.get("name"),
            csrf=session.get("csrf"),
            needs_code=bool(app.config["ACCESS_CODE"]),
        )

    @app.post("/api/login")
    def login():
        body = request.get_json()
        if not isinstance(body.get("name", ""), str):
            raise ValueError("Nom de relecteur invalide.")
        name = body.get("name", "").strip()
        if not 1 <= len(name) <= 80:
            raise ValueError("Indiquez votre prénom ou votre nom d’équipe.")
        if not secrets.compare_digest(
            str(body.get("code", "")).encode(), app.config["ACCESS_CODE"].encode()
        ):
            return jsonify(error="Code d’accès incorrect."), 403
        session.clear()
        session.update(
            reviewer_id=uuid.uuid4().hex, name=name, csrf=secrets.token_hex(24)
        )
        return jsonify(name=name, csrf=session["csrf"])

    @app.get("/api/bootstrap")
    def bootstrap():
        return jsonify(
            version=store.dataset["version"],
            contexts=store.dataset["contexts"],
            destinations={
                key: {"url": row["url"], "occurrence_count": len(row["occurrences"])}
                for key, row in store.dataset["destinations"].items()
            },
            decisions=store.snapshot(session["reviewer_id"]),
        )

    @app.post("/api/logout")
    def logout():
        store.release_actor(session["reviewer_id"])
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/decisions")
    def refresh():
        return jsonify(decisions=store.snapshot(session["reviewer_id"]))

    @app.post("/api/claim")
    def claim():
        store.claim(
            request.get_json().get("key"), session["reviewer_id"], session["name"]
        )
        return jsonify(decisions=store.snapshot(session["reviewer_id"]))

    @app.post("/api/release")
    def release():
        store.release(request.get_json().get("key"), session["reviewer_id"])
        return jsonify(ok=True)

    @app.post("/api/heartbeat")
    def heartbeat():
        store.renew(request.get_json().get("key"), session["reviewer_id"])
        return jsonify(decisions=store.snapshot(session["reviewer_id"]))

    @app.post("/api/decision")
    def decide():
        body = request.get_json()
        event = store.change(
            body.get("key"),
            body.get("version"),
            body.get("action"),
            session["reviewer_id"],
            session["name"],
            category=body.get("category"),
            event_id=body.get("event_id"),
        )
        return jsonify(event_id=event, decisions=store.snapshot(session["reviewer_id"]))

    @app.get("/api/history/<key>")
    def history(key):
        return jsonify(events=store.history(key))

    @app.get("/api/export")
    def export():
        response = jsonify(store.export())
        response.headers["Content-Disposition"] = (
            'attachment; filename="pdcv-decisions.json"'
        )
        return response

    return app


def main():
    parser = argparse.ArgumentParser(
        description="Run Step 2 locally. On Heroku use the Procfile."
    )
    parser.add_argument("--port", type=int, default=8770)
    args = parser.parse_args()
    store = Store(database_url())
    store.initialize(
        json.loads(Path(__file__).with_name("dataset.json").read_text(encoding="utf-8"))
    )
    app = create_app({"STORE": store})
    app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()

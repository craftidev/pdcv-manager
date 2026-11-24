from __future__ import annotations

import re
from urllib.parse import urlsplit

from pdcv.extract import destination, soup

PATTERNS = {
    "relais": re.compile(r"\b(?:relai|relais)\b", re.IGNORECASE),
    "service": re.compile(
        r"\b(?:dispositifs?|programmes?|ressources?|contacts?)\b", re.IGNORECASE
    ),
}


def matches(text: str) -> list[dict]:
    return [
        {
            "category": category,
            "keyword": match.group(),
            "start": match.start(),
            "end": match.end(),
        }
        for category, pattern in PATTERNS.items()
        for match in pattern.finditer(text)
    ]


def exclusion(url: str) -> str | None:
    parsed = urlsplit(url)
    if parsed.scheme.lower() in {"mailto", "tel"}:
        return parsed.scheme.lower()
    if parsed.hostname == "agirpourlatransition.ademe.fr":
        return "internal"
    return None


def local_evidence(context: dict, occurrence: dict) -> list[dict]:
    evidence = []
    scopes = [("label", occurrence["label"])]
    root = soup(context["description_html"])
    candidates = [
        anchor
        for anchor in root.select("a[href]")
        if destination(anchor["href"], context["page_url"]) == occurrence["destination"]
    ]
    # Edited HTML can omit or repeat a URL. Ambiguous ownership contributes no block evidence.
    if len(candidates) == 1:
        for parent in candidates[0].parents:
            if parent.name in {"p", "li"} and len(parent.select("a[href]")) == 1:
                block = soup(str(parent))
                for heading in block.select("h1,h2,h3,h4,h5,h6"):
                    heading.decompose()
                scopes.append((parent.name, block.get_text(" ", strip=True)))
    seen = set()
    for scope, text in scopes:
        for hit in matches(text):
            key = (scope, text, hit["category"], hit["keyword"].casefold())
            if key in seen:
                continue
            seen.add(key)
            evidence.append(
                {
                    "kind": "keyword",
                    "scope": scope,
                    "snippet": text,
                    "category": hit["category"],
                    "keyword": hit["keyword"],
                    "context_id": context["id"],
                    "occurrence_id": occurrence["id"],
                }
            )
    return evidence


def decide(url: str, occurrences: list[dict], evidence: list[dict]) -> dict:
    reason = exclusion(url)
    if reason:
        return {
            "category": "ignore",
            "origin": "auto",
            "evidence": [{"kind": reason}],
            "conflict": False,
        }
    if all(o["integration_hold"] for o in occurrences):
        return {
            "category": "held",
            "origin": "auto",
            "evidence": [{"kind": "region_hold"}],
            "conflict": False,
        }
    categories = {item["category"] for item in evidence}
    if len(categories) == 1:
        return {
            "category": categories.pop(),
            "origin": "auto",
            "evidence": evidence,
            "conflict": False,
        }
    return {
        "category": None,
        "origin": "unresolved",
        "evidence": evidence,
        "conflict": len(categories) > 1,
    }

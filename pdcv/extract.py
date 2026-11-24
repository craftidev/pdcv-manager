from __future__ import annotations

import hashlib
import unicodedata
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def text(html: str) -> str:
    return soup(html).get_text(" ", strip=True)


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    return "".join(c for c in value if c.isalnum() and not unicodedata.combining(c))


def region(label: str, helpers: Path) -> dict:
    key = normalized(label)
    if key == normalized("Toutes les régions"):
        return {"label": label, "code": None, "hold": "all_regions_without_approved_id"}
    for line in (
        (helpers / "corespondance-regions.txt").read_text(encoding="utf-8").splitlines()
    ):
        code, labels = line.split(":", 1)
        aliases = [alias.strip() for alias in labels.split(";") if alias.strip()]
        if key in [normalized(alias) for alias in aliases]:
            return {
                "label": label,
                "canonical": aliases[0],
                "code": code.strip(),
                "hold": None,
            }
    return {"label": label, "code": None, "hold": "unknown_region"}


def destination(href: str, base_url: str) -> str:
    resolved = urlsplit(urljoin(base_url, href))
    # Preserve paths, trailing slashes, queries, and fragments: no speculative equivalence.
    return urlunsplit(
        (
            resolved.scheme.lower(),
            resolved.netloc.lower(),
            resolved.path,
            resolved.query,
            resolved.fragment,
        )
    )


def entry_inventory(
    *,
    page_url: str,
    component_uuid: str,
    entry_key: str,
    title_html: str,
    source_html: str,
    helpers: Path,
    source_kind: str,
) -> dict:
    root = soup(source_html)
    headings = [h.get_text(" ", strip=True) for h in root.select("h1,h2,h3,h4,h5,h6")]
    anchors = root.select("a[href]")
    context_id = fingerprint(f"{page_url}\n{component_uuid}\n{entry_key}")[:24]
    issues = []
    if len(headings) != 1:
        issues.append("ambiguous_heading_structure")
    if len(anchors) != 1:
        issues.append("multiple_links" if anchors else "no_links")
    mapped_region = region(text(title_html), helpers)
    if mapped_region["hold"]:
        issues.append(mapped_region["hold"])
    return {
        "entry_key": entry_key,
        "component_uuid": component_uuid,
        "region": mapped_region,
        "source_kind": source_kind,
        "source_sha256": fingerprint(source_html),
        "source_html": source_html,
        "context": {
            "id": context_id,
            "headings": headings,
            "text": root.get_text(" ", strip=True),
            "images": [
                {
                    "src": urljoin(page_url, img.get("src", "")),
                    "alt": img.get("alt", ""),
                }
                for img in root.select("img[src]")
            ],
            "needs_precheck": bool(issues),
            "issues": issues,
        },
        "occurrences": [
            {
                "id": f"{context_id}:{index}",
                "anchor_index": index,
                "href": anchor["href"],
                "destination": destination(anchor["href"], page_url),
                "label": anchor.get_text(" ", strip=True),
                "attributes": dict(anchor.attrs),
                "anchor_html": str(anchor),
                "integration_hold": mapped_region["hold"],
            }
            for index, anchor in enumerate(anchors)
        ],
    }


def builder_entries(html: str) -> list[dict]:
    root = soup(html)
    result = []
    for item in root.select('[data-type="accordion_item"]'):
        title = item.select_one(".field--name-field-accordion-title")
        body = item.select_one(".field--name-field-text-long-1 > .field__item")
        if title is None or body is None or not item.get("data-uuid"):
            raise ValueError("Accordion entry is missing a title, body, or UUID")
        result.append(
            {
                "entry_key": item["data-uuid"],
                "title_html": title.decode_contents(),
                "source_html": body.decode_contents(),
            }
        )
    if not result:
        raise ValueError("No accordion entries found")
    return result


def editor_source(html: str) -> tuple[str, str]:
    root = soup(html)
    title = root.select_one('textarea[name="field_accordion_title[0][value]"]')
    body = root.select_one('textarea[name="field_text_long_1[0][value]"]')
    if title is None or body is None:
        raise ValueError("Entry editor fixture is missing expected fields")
    return title.get_text(), body.get_text()


def tribune_inventory(html: str, url: str) -> dict:
    root = soup(html)
    answer = root.select("article.question-details .html-response[itemprop='text']")
    if len(answer) != 1:
        raise ValueError(f"Expected one Tribune answer, found {len(answer)}")
    title = root.select_one("article.question-details h1")
    content = answer[0].decode_contents()
    return {
        "url": url,
        "title": title.get_text(" ", strip=True) if title else None,
        "source_html": content,
        "source_sha256": fingerprint(content),
        "links": [
            {
                "href": a["href"],
                "destination": destination(a["href"], url),
                "label": a.get_text(" ", strip=True),
            }
            for a in answer[0].select("a[href]")
        ],
    }


def tribune_entries(html: str, url: str) -> list[str]:
    return list(
        dict.fromkeys(
            destination(a["href"], url)
            for a in soup(html).select("ul.question-list a[href]")
        )
    )


def summary(entries: list[dict]) -> dict:
    return {
        "entries": len(entries),
        "links": sum(len(e["occurrences"]) for e in entries),
        "contexts_needing_precheck": sum(
            e["context"]["needs_precheck"] for e in entries
        ),
        "held_links": sum(
            bool(o["integration_hold"]) for e in entries for o in e["occurrences"]
        ),
    }

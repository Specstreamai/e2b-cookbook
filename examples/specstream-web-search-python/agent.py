"""Research agent loop that runs inside an E2B sandbox using SpecStream Search and Extract."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.specstream.ai"
DEFAULT_QUESTION = "What are E2B sandboxes and how do AI agents use them?"
DEFAULT_OUTPUT_PATH = "/home/user/answer.md"
MAX_STEPS = 3
TARGET_EXTRACTED = 2
BATCH_SIZE = 3
SEARCH_NUM = 6
REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRY_WAIT_SECONDS = 10

STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "how",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "their",
        "them",
        "they",
        "this",
        "to",
        "use",
        "used",
        "using",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
    }
)


class SpecStreamError(RuntimeError):
    """Raised when the SpecStream API returns an error response."""


@dataclass
class ExtractedSource:
    """Grounded source page returned by SpecStream Extract or Search fallback."""

    url: str
    title: str
    text: str
    snippet: str = ""
    published: str | None = None
    modified: str | None = None
    read_from: str | None = None


@dataclass
class AgentResult:
    """Final output and telemetry produced by the agent loop."""

    question: str
    answer_markdown: str
    sources: list[ExtractedSource] = field(default_factory=list)
    steps: int = 0
    total_price_usd: float = 0.0


HttpTransport = Callable[[str, str, dict[str, str], bytes | None, int], tuple[int, dict[str, str], bytes]]


def _default_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: int,
) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, resp.read()
    except urllib.error.HTTPError as exc:
        resp_headers = {k.lower(): v for k, v in exc.headers.items()}
        return exc.code, resp_headers, exc.read()


def _parse_json_response(status: int, raw_body: bytes, endpoint: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SpecStreamError(f"SpecStream {endpoint} returned invalid JSON (HTTP {status}).") from exc

    if status >= 400 or "error" in payload:
        error = payload.get("error") or {}
        code = error.get("code") or f"http_{status}"
        message = error.get("message") or f"HTTP {status} from {endpoint}"
        raise SpecStreamError(f"SpecStream {endpoint} failed ({code}): {message}")

    data = payload.get("data")
    if not isinstance(data, dict):
        raise SpecStreamError(f"SpecStream {endpoint} response missing 'data' object.")
    return data


class SpecStreamClient:
    """Minimal stdlib client for SpecStream Search and Extract endpoints."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        transport: HttpTransport | None = None,
    ) -> None:
        cleaned_key = api_key.strip()
        if not cleaned_key:
            raise ValueError("SPECSTREAM_API_KEY must be non-empty.")
        self._api_key = cleaned_key
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _default_transport

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        raw_body: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            raw_body = json.dumps(body).encode("utf-8")

        for attempt in range(2):
            status, resp_headers, resp_bytes = self._transport(
                method, url, headers, raw_body, REQUEST_TIMEOUT_SECONDS
            )
            if status == 503 and attempt == 0:
                retry_after = _parse_retry_after(resp_headers.get("retry-after"))
                if retry_after is not None and retry_after <= MAX_RETRY_WAIT_SECONDS:
                    time.sleep(retry_after)
                    continue
            return _parse_json_response(status, resp_bytes, path.split("?")[0])

        raise SpecStreamError(f"SpecStream {path} failed after retry.")

    def web_search(
        self,
        query: str,
        *,
        speed: str = "fast",
        num: int = SEARCH_NUM,
        page: int = 1,
    ) -> dict[str, Any]:
        params = urllib.parse.urlencode(
            {
                "q": query,
                "speed": speed,
                "num": num,
                "page": page,
            }
        )
        return self._request_json("GET", f"/v1/web-search?{params}")

    def extract(self, urls: list[str], *, output_format: str = "markdown") -> dict[str, Any]:
        if not urls:
            raise ValueError("urls must not be empty.")
        return self._request_json(
            "POST",
            "/v1/extract",
            body={"urls": urls[:20], "format": output_format},
        )


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return seconds if seconds >= 0 else None
    except ValueError:
        return None


def _keywords(question: str) -> set[str]:
    tokens = re.findall(r"[a-z0-9]{3,}", question.lower())
    filtered = {tok for tok in tokens if tok not in STOP_WORDS}
    return filtered or set(tokens)


def _select_candidate_urls(
    candidates: list[dict[str, Any]],
    visited: set[str],
    limit: int,
) -> list[str]:
    """Pick unvisited URLs, prioritizing distinct domains first for source diversity."""
    selected: list[str] = []
    seen_sites: set[str] = set()
    deferred: list[str] = []

    for src in candidates:
        url = src.get("url")
        if not isinstance(url, str) or not url or url in visited or url in selected or url in deferred:
            continue
        site = (src.get("site") or urllib.parse.urlparse(url).netloc or "").lower()
        if site and site not in seen_sites:
            seen_sites.add(site)
            selected.append(url)
            if len(selected) >= limit:
                return selected
        else:
            deferred.append(url)

    for url in deferred:
        if len(selected) >= limit:
            break
        selected.append(url)
    return selected


def _clean_markdown_lines(text: str) -> list[str]:
    """Extract clean prose lines/sentences from extracted markdown text."""
    stripped = re.sub(r"```[\s\S]*?```", " ", text)
    candidates: list[str] = []
    for raw_line in stripped.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("#", "![", "---", "***", "|")):
            continue
        # Convert markdown links [label](url) to label and strip inline formatting.
        line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)
        line = re.sub(r"^[-*+]\s+", "", line)
        line = re.sub(r"[*_`]+", "", line).strip()
        if len(line) < 40:
            continue
        # Skip lines that look like navigation menus or cookie banners.
        lower = line.lower()
        if any(noise in lower for noise in ("cookie", "sign in", "subscribe", "all rights reserved")):
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", line):
            sentence = sentence.strip()
            if len(sentence) >= 40:
                candidates.append(sentence)
    return candidates


def _best_excerpt(source: ExtractedSource, query_terms: set[str]) -> str:
    lines = _clean_markdown_lines(source.text)
    if not lines:
        fallback = source.snippet.strip() or source.text.strip()
        return _truncate_cleanly(fallback, 260)

    def score(item: tuple[int, str]) -> tuple[int, int]:
        idx, sentence = item
        words = set(re.findall(r"[a-z0-9]{3,}", sentence.lower()))
        overlap = len(words & query_terms)
        # Prefer higher keyword overlap, then earlier position in the article.
        return (overlap, -idx)

    best_idx, best_sentence = max(enumerate(lines[:40]), key=score)
    _ = best_idx
    return _truncate_cleanly(best_sentence, 280)


def _truncate_cleanly(text: str, max_chars: int) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= max_chars:
        return normalized
    clipped = normalized[: max_chars - 3].rsplit(" ", 1)[0].rstrip(".,;:")
    return f"{clipped}..."


def format_sourced_answer(question: str, sources: list[ExtractedSource]) -> str:
    """Format a concise Markdown answer with numbered inline citations."""
    query_terms = _keywords(question)
    lines = ["# Answer", "", f"**Question:** {question}", ""]

    if not sources:
        lines.append("No relevant sources were found for this question.")
        return "\n".join(lines) + "\n"

    lines.append("## Key findings")
    lines.append("")
    for index, source in enumerate(sources, start=1):
        excerpt = _best_excerpt(source, query_terms)
        lines.append(f"- {excerpt} [{index}]")

    lines.extend(["", "## Sources", ""])
    for index, source in enumerate(sources, start=1):
        title = source.title or source.url
        details: list[str] = []
        if source.published:
            details.append(f"published {source.published}")
        if source.modified and source.modified != source.published:
            details.append(f"updated {source.modified}")
        if source.read_from:
            details.append(f"read via {source.read_from}")
        suffix = f" ({', '.join(details)})" if details else ""
        lines.append(f"{index}. [{title}]({source.url}){suffix}")

    return "\n".join(lines) + "\n"


def run_agent(
    question: str,
    client: SpecStreamClient,
    *,
    max_steps: int = MAX_STEPS,
    target_sources: int = TARGET_EXTRACTED,
    batch_size: int = BATCH_SIZE,
    log: Callable[[str], None] = print,
) -> AgentResult:
    """Run an iterative search-and-extract loop until enough grounded sources are gathered."""
    visited_urls: set[str] = set()
    candidate_pool: list[dict[str, Any]] = []
    source_meta_by_url: dict[str, dict[str, Any]] = {}
    extracted: list[ExtractedSource] = []

    search_page = 1
    next_page: int | None = 1
    total_price_usd = 0.0
    steps_taken = 0

    for step in range(1, max_steps + 1):
        steps_taken = step
        batch_urls = _select_candidate_urls(candidate_pool, visited_urls, batch_size)

        if not batch_urls and next_page is not None:
            search_data = client.web_search(question, speed="fast", num=SEARCH_NUM, page=search_page)
            total_price_usd += float(search_data.get("price_usd") or 0.0)
            new_sources = search_data.get("sources") or []
            for src in new_sources:
                url = src.get("url")
                if isinstance(url, str) and url and url not in source_meta_by_url:
                    source_meta_by_url[url] = src
                    candidate_pool.append(src)
            next_page = search_data.get("next_page")
            if isinstance(next_page, int):
                search_page = next_page
            else:
                next_page = None
            log(f"[step {step}] web-search page returned {len(new_sources)} sources")
            batch_urls = _select_candidate_urls(candidate_pool, visited_urls, batch_size)

        if not batch_urls:
            log(f"[step {step}] no remaining candidate URLs to extract")
            break

        visited_urls.update(batch_urls)
        extract_data = client.extract(batch_urls, output_format="markdown")
        total_price_usd += float(extract_data.get("price_usd") or 0.0)
        results = extract_data.get("results") or []

        ok_in_batch = 0
        for item in results:
            url = item.get("url")
            status = item.get("status")
            text = item.get("text") or ""
            if status == "ok" and text.strip() and isinstance(url, str):
                meta = source_meta_by_url.get(url, {})
                extracted.append(
                    ExtractedSource(
                        url=url,
                        title=(item.get("title") or meta.get("title") or url).strip(),
                        text=text,
                        snippet=(meta.get("snippet") or "").strip(),
                        published=item.get("published") or meta.get("published"),
                        modified=item.get("modified") or meta.get("modified"),
                        read_from=item.get("read_from"),
                    )
                )
                ok_in_batch += 1

        log(
            f"[step {step}] extracted {len(batch_urls)} URLs -> "
            f"{ok_in_batch} ok ({len(extracted)}/{target_sources} collected)"
        )

        if len(extracted) >= target_sources:
            break

    # If live extraction was blocked or empty on every URL, fall back to search snippets.
    if not extracted and candidate_pool:
        for src in candidate_pool[:target_sources]:
            url = src.get("url")
            if not isinstance(url, str) or not url:
                continue
            extracted.append(
                ExtractedSource(
                    url=url,
                    title=(src.get("title") or url).strip(),
                    text=src.get("snippet") or "",
                    snippet=src.get("snippet") or "",
                    published=src.get("published"),
                    modified=src.get("modified"),
                )
            )

    answer_markdown = format_sourced_answer(question, extracted[:3])
    return AgentResult(
        question=question,
        answer_markdown=answer_markdown,
        sources=extracted[:3],
        steps=steps_taken,
        total_price_usd=round(total_price_usd, 6),
    )


def main() -> int:
    api_key = os.environ.get("SPECSTREAM_API_KEY", "").strip()
    if not api_key:
        print("Missing SPECSTREAM_API_KEY in environment.", file=sys.stderr)
        return 1

    question = " ".join(sys.argv[1:]).strip() or os.environ.get("QUESTION", "").strip() or DEFAULT_QUESTION
    output_path = Path(os.environ.get("OUTPUT_PATH", DEFAULT_OUTPUT_PATH))
    base_url = os.environ.get("SPECSTREAM_BASE_URL", DEFAULT_BASE_URL)

    client = SpecStreamClient(api_key=api_key, base_url=base_url)
    result = run_agent(question, client)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result.answer_markdown, encoding="utf-8")

    print(f"\nWrote {output_path} in {result.steps} step(s) (total API cost: ${result.total_price_usd:.4f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

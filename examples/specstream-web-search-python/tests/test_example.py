from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any

EXAMPLE_DIR = Path(__file__).resolve().parent.parent
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import agent
import main as host_main


class FakeTransport:
    def __init__(self, responses: list[tuple[int, dict[str, str], dict[str, Any]]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: int,
    ) -> tuple[int, dict[str, str], bytes]:
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": json.loads(body.decode("utf-8")) if body else None,
                "timeout": timeout,
            }
        )
        status, resp_headers, payload = self.responses.pop(0)
        return status, resp_headers, json.dumps(payload).encode("utf-8")


class TestSpecStreamAgent(unittest.TestCase):
    def test_search_and_extract_loop_retries_failed_urls_and_cites_sources(self) -> None:
        transport = FakeTransport(
            [
                (
                    200,
                    {},
                    {
                        "data": {
                            "request_id": "req_search_1",
                            "query": "E2B sandboxes",
                            "took_ms": 180,
                            "price_usd": 0.001,
                            "next_page": 2,
                            "sources": [
                                {
                                    "url": "https://blocked.example.com/post",
                                    "title": "Blocked site",
                                    "site": "blocked.example.com",
                                    "snippet": "Blocked snippet",
                                },
                                {
                                    "url": "https://e2b.dev/docs",
                                    "title": "E2B Documentation",
                                    "site": "e2b.dev",
                                    "snippet": "E2B provides cloud sandboxes for AI agents.",
                                    "published": "2026-03-10",
                                },
                                {
                                    "url": "https://specstream.ai/docs",
                                    "title": "SpecStream Docs",
                                    "site": "specstream.ai",
                                    "snippet": "SpecStream provides live web search and extract APIs.",
                                },
                            ],
                        }
                    },
                ),
                (
                    200,
                    {},
                    {
                        "data": {
                            "request_id": "req_extract_1",
                            "took_ms": 420,
                            "price_usd": 0.0016,
                            "results": [
                                {
                                    "url": "https://blocked.example.com/post",
                                    "status": "blocked",
                                    "title": None,
                                    "text": "",
                                    "published": None,
                                },
                                {
                                    "url": "https://e2b.dev/docs",
                                    "status": "ok",
                                    "title": "E2B Documentation",
                                    "text": "# E2B\n\nE2B sandboxes give AI agents isolated cloud microVMs for running code safely.",
                                    "published": "2026-03-10",
                                    "read_from": "live",
                                },
                                {
                                    "url": "https://specstream.ai/docs",
                                    "status": "ok",
                                    "title": "SpecStream Docs",
                                    "text": "Agents running inside sandboxes call SpecStream Search and Extract over HTTPS.",
                                    "published": None,
                                    "read_from": "live",
                                },
                            ],
                        }
                    },
                ),
            ]
        )

        client = agent.SpecStreamClient(api_key="ss_test_key", transport=transport)
        logs: list[str] = []
        result = agent.run_agent(
            "How do AI agents use E2B sandboxes?",
            client,
            target_sources=2,
            log=logs.append,
        )

        self.assertEqual(result.steps, 1)
        self.assertEqual(len(result.sources), 2)
        self.assertAlmostEqual(result.total_price_usd, 0.0026)
        self.assertIn("[1]", result.answer_markdown)
        self.assertIn("[2]", result.answer_markdown)
        self.assertIn("https://e2b.dev/docs", result.answer_markdown)
        self.assertIn("https://specstream.ai/docs", result.answer_markdown)

        search_call = transport.calls[0]
        self.assertEqual(search_call["method"], "GET")
        self.assertIn("/v1/web-search?", search_call["url"])
        self.assertIn("speed=fast", search_call["url"])
        self.assertEqual(search_call["headers"]["Authorization"], "Bearer ss_test_key")

        extract_call = transport.calls[1]
        self.assertEqual(extract_call["method"], "POST")
        self.assertTrue(extract_call["url"].endswith("/v1/extract"))
        self.assertEqual(
            extract_call["body"],
            {
                "urls": [
                    "https://blocked.example.com/post",
                    "https://e2b.dev/docs",
                    "https://specstream.ai/docs",
                ],
                "format": "markdown",
            },
        )

    def test_loop_iterates_to_second_batch_when_first_batch_yields_one_ok_page(self) -> None:
        transport = FakeTransport(
            [
                (
                    200,
                    {},
                    {
                        "data": {
                            "request_id": "req_search_2",
                            "query": "test",
                            "took_ms": 120,
                            "price_usd": 0.001,
                            "next_page": None,
                            "sources": [
                                {"url": "https://a.example.com", "title": "A", "site": "a.example.com", "snippet": "A"},
                                {"url": "https://b.example.com", "title": "B", "site": "b.example.com", "snippet": "B"},
                                {"url": "https://c.example.com", "title": "C", "site": "c.example.com", "snippet": "C"},
                                {"url": "https://d.example.com", "title": "D", "site": "d.example.com", "snippet": "D"},
                            ],
                        }
                    },
                ),
                (
                    200,
                    {},
                    {
                        "data": {
                            "request_id": "req_extract_a",
                            "took_ms": 200,
                            "price_usd": 0.0008,
                            "results": [
                                {"url": "https://a.example.com", "status": "ok", "title": "A", "text": "Source A provides detailed benchmark numbers for search accuracy.", "published": None},
                                {"url": "https://b.example.com", "status": "empty", "title": None, "text": "", "published": None},
                                {"url": "https://c.example.com", "status": "not_found", "title": None, "text": "", "published": None},
                            ],
                        }
                    },
                ),
                (
                    200,
                    {},
                    {
                        "data": {
                            "request_id": "req_extract_b",
                            "took_ms": 190,
                            "price_usd": 0.0008,
                            "results": [
                                {"url": "https://d.example.com", "status": "ok", "title": "D", "text": "Source D confirms the extraction pipeline supports markdown output.", "published": None},
                            ],
                        }
                    },
                ),
            ]
        )

        client = agent.SpecStreamClient(api_key="ss_test_key", transport=transport)
        result = agent.run_agent("benchmark search extraction", client, target_sources=2, log=lambda _: None)

        self.assertEqual(result.steps, 2)
        self.assertEqual([s.url for s in result.sources], ["https://a.example.com", "https://d.example.com"])

    def test_error_envelope_raises_without_leaking_key(self) -> None:
        transport = FakeTransport(
            [
                (
                    401,
                    {},
                    {"error": {"code": "invalid_token", "message": "Invalid API key."}},
                )
            ]
        )
        client = agent.SpecStreamClient(api_key="ss_secret_value", transport=transport)
        with self.assertRaises(agent.SpecStreamError) as ctx:
            client.web_search("test")
        self.assertNotIn("ss_secret_value", str(ctx.exception))
        self.assertIn("invalid_token", str(ctx.exception))


class FakeSandboxFiles:
    def __init__(self) -> None:
        self.written: dict[str, str] = {}
        self.stored: dict[str, str] = {
            host_main.OUTPUT_SANDBOX_PATH: "# Answer\n\nMocked sourced answer [1]\n"
        }

    def write(self, path: str, content: str) -> None:
        self.written[path] = content

    def read(self, path: str) -> str:
        return self.stored[path]


class FakeSandboxCommands:
    def __init__(self) -> None:
        self.runs: list[dict[str, Any]] = []

    def run(self, command: str, **kwargs: Any) -> None:
        self.runs.append({"command": command, "kwargs": kwargs})


class FakeSandbox:
    def __init__(self) -> None:
        self.sandbox_id = "sbx_test_123"
        self.files = FakeSandboxFiles()
        self.commands = FakeSandboxCommands()
        self.killed = False

    def kill(self) -> None:
        self.killed = True


class TestHostRunner(unittest.TestCase):
    def test_require_keys_checks_both_env_vars(self) -> None:
        with self.assertRaises(RuntimeError):
            host_main.require_keys({"SPECSTREAM_API_KEY": "ss_123"})
        with self.assertRaises(RuntimeError):
            host_main.require_keys({"E2B_API_KEY": "e2b_123"})
        self.assertEqual(
            host_main.require_keys({"E2B_API_KEY": "e2b_123", "SPECSTREAM_API_KEY": "ss_123"}),
            ("e2b_123", "ss_123"),
        )

    def test_run_example_uploads_agent_runs_in_sandbox_and_kills_sandbox(self) -> None:
        fake_sbx = FakeSandbox()
        factory_calls: list[dict[str, Any]] = []

        def fake_factory(**kwargs: Any) -> FakeSandbox:
            factory_calls.append(kwargs)
            return fake_sbx

        answer = host_main.run_example(
            "What is E2B?",
            env={"E2B_API_KEY": "e2b_test", "SPECSTREAM_API_KEY": "ss_test"},
            sandbox_factory=fake_factory,
        )

        self.assertIn("Mocked sourced answer", answer)
        self.assertTrue(fake_sbx.killed)
        self.assertIn(host_main.AGENT_SANDBOX_PATH, fake_sbx.files.written)
        self.assertEqual(len(fake_sbx.commands.runs), 1)
        run_call = fake_sbx.commands.runs[0]
        self.assertEqual(run_call["command"], f"python3 {host_main.AGENT_SANDBOX_PATH}")
        self.assertEqual(
            run_call["kwargs"]["envs"],
            {
                "SPECSTREAM_API_KEY": "ss_test",
                "QUESTION": "What is E2B?",
                "OUTPUT_PATH": host_main.OUTPUT_SANDBOX_PATH,
            },
        )


if __name__ == "__main__":
    unittest.main()

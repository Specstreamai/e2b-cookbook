"""Run the SpecStream search-and-extract agent loop inside an E2B sandbox."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from e2b import Sandbox

EXAMPLE_DIR = Path(__file__).resolve().parent
AGENT_LOCAL_PATH = EXAMPLE_DIR / "agent.py"
AGENT_SANDBOX_PATH = "/home/user/agent.py"
OUTPUT_SANDBOX_PATH = "/home/user/answer.md"
DEFAULT_QUESTION = "What are E2B sandboxes and how do AI agents use them?"
SANDBOX_TIMEOUT_SECONDS = 5 * 60
COMMAND_TIMEOUT_SECONDS = 2 * 60


def require_keys(env: Mapping[str, str]) -> tuple[str, str]:
    e2b_key = (env.get("E2B_API_KEY") or "").strip()
    if not e2b_key:
        raise RuntimeError("Missing E2B_API_KEY. Copy .env.example to .env and fill in your keys.")

    specstream_key = (env.get("SPECSTREAM_API_KEY") or "").strip()
    if not specstream_key:
        raise RuntimeError("Missing SPECSTREAM_API_KEY. Copy .env.example to .env and fill in your keys.")

    return e2b_key, specstream_key


def run_example(
    question: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
    sandbox_factory: Callable[..., Any] = Sandbox.create,
) -> str:
    """Create a sandbox, run the SpecStream agent inside it, and return the sourced answer."""
    environment = os.environ if env is None else env
    _, specstream_key = require_keys(environment)

    resolved_question = (question or environment.get("QUESTION") or "").strip() or DEFAULT_QUESTION
    agent_source = AGENT_LOCAL_PATH.read_text(encoding="utf-8")

    sbx = sandbox_factory(timeout=SANDBOX_TIMEOUT_SECONDS)
    print(f"Sandbox created: {sbx.sandbox_id}")

    try:
        sbx.files.write(AGENT_SANDBOX_PATH, agent_source)
        sbx.commands.run(
            f"python3 {AGENT_SANDBOX_PATH}",
            envs={
                "SPECSTREAM_API_KEY": specstream_key,
                "QUESTION": resolved_question,
                "OUTPUT_PATH": OUTPUT_SANDBOX_PATH,
            },
            timeout=COMMAND_TIMEOUT_SECONDS,
            on_stdout=lambda data: print(data, end=""),
            on_stderr=lambda data: print(data, end="", file=sys.stderr),
        )

        answer = sbx.files.read(OUTPUT_SANDBOX_PATH)
        print("\n--- answer.md ---")
        print(answer)
        return answer
    finally:
        sbx.kill()


def main() -> int:
    load_dotenv()
    cli_question = " ".join(sys.argv[1:]).strip() or None
    try:
        run_example(cli_question)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""The files MST reads for one rollout, and the trial it writes back.

A rollout is one MST trial: a one-case dataset and an eval config with one variant,
collected by `mst run --no-grade`. MST runs the client the way it does in any eval;
this module only writes MST's documented inputs and reads its documented output
(the `mst.run/v1` trial file, schema/run/v1/trial.schema.json).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

CASE_ID = "rollout"
DATASET_NAME = "verifiers"

# Clients whose options include `systemPrompt`. Others get the system prompt
# folded into the input, as verifiers does for a harness that can't take one.
SYSTEM_PROMPT_CLIENTS = frozenset({"api", "claude-code", "codex-cli"})

WriteMode = Literal["unguarded", "live", "read-only"]


@dataclass(frozen=True)
class TrialRequest:
    """What one rollout asks MST to run."""

    client: str
    model: str
    prompt: str
    mcp_urls: Mapping[str, str]
    system_prompt: str | None = None
    client_options: Mapping[str, Any] | None = None
    plugins: tuple[str, ...] = ()
    writes: WriteMode = "unguarded"
    name: str = "verifiers-rollout"


def dataset(request: TrialRequest) -> dict[str, Any]:
    """The one-case dataset: the task's prompt is the case's input, unchanged."""
    prompt = request.prompt
    if request.system_prompt and request.client not in SYSTEM_PROMPT_CLIENTS:
        prompt = f"{request.system_prompt}\n\n{prompt}"
    if not prompt.strip():
        raise ValueError("The task's prompt is empty; MST rejects an empty case input.")
    return {"name": DATASET_NAME, "cases": [{"id": CASE_ID, "input": prompt}]}


def eval_config(request: TrialRequest, dataset_path: str) -> dict[str, Any]:
    """The eval config for one rollout.

    The task's MCP servers become the variant's servers, by name. Their writes are
    the taskset's to handle (its own proxy decides what reaches a service), so they
    are declared `unguarded` by default: MST can't see them and doesn't stop them.
    Transcripts are stored unredacted so the harness can return them.
    """
    servers: dict[str, Any] = {
        name: {"transport": "http", "serverUrl": url}
        for name, url in sorted(request.mcp_urls.items())
    }
    options: dict[str, Any] = dict(request.client_options or {})
    if request.system_prompt and request.client in SYSTEM_PROMPT_CLIENTS:
        options.setdefault("systemPrompt", request.system_prompt)
    config: dict[str, Any] = {
        "name": request.name,
        "datasets": [{"type": "file", "path": dataset_path}],
        "servers": servers,
        "client": request.client,
        "model": request.model,
        "redactStoredResponses": False,
    }
    if options:
        config["clientOptions"] = options
    if request.plugins:
        config["plugins"] = list(request.plugins)
    if servers and request.writes != "read-only":
        config["writes"] = dict.fromkeys(servers, request.writes)
    return config


@dataclass(frozen=True)
class TrialResult:
    """What MST recorded for the rollout's one trial."""

    final_text: str
    ending: dict[str, Any]
    error: str | None
    transcript: dict[str, Any]
    raw: dict[str, Any]

    @property
    def collected(self) -> bool:
        """Whether the client's attempt was a trial, not an infrastructure failure.

        `ending` is `{"kind": "trial"}` or `{"kind": "infrastructure", "broke", ...}`.
        """
        return self.ending.get("kind") == "trial"

    @property
    def model_calls(self) -> int:
        """How many model calls MST saw the client make."""
        calls = self.transcript.get("modelCalls")
        return len(calls) if isinstance(calls, list) else 0

    @property
    def failure(self) -> str:
        """What broke, for an infrastructure ending."""
        broke = self.ending.get("broke", "unknown")
        reason = self.ending.get("reason") or self.error or "no reason recorded"
        return f"{broke}: {reason}"

    def info(self) -> dict[str, Any]:
        """The part of the trial a rollout keeps in `trace.info["mst"]`."""
        return {
            "format": self.raw.get("format"),
            "ending": self.ending,
            "error": self.error,
            "durationMs": self.raw.get("durationMs"),
            "evidence": self.transcript.get("evidence"),
            "transcript": self.transcript,
            "writeRecord": self.raw.get("writeRecord"),
        }


def parse_trial(data: bytes | str) -> TrialResult:
    """Read MST's trial file (`transcripts/<variant>/<case>/<trial>.json`)."""
    raw = json.loads(data)
    if not isinstance(raw, dict):
        raise ValueError("MST's trial file is not a JSON object")
    trial: dict[str, Any] = raw
    transcript = trial.get("transcript")
    transcript = transcript if isinstance(transcript, dict) else {}
    final_text = transcript.get("finalText")
    ending = trial.get("ending")
    error = trial.get("error")
    return TrialResult(
        final_text=final_text if isinstance(final_text, str) else "",
        ending=ending if isinstance(ending, dict) else {},
        error=error if isinstance(error, str) else None,
        transcript=transcript,
        raw=trial,
    )

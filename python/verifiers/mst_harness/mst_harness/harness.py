"""Run an MST client as a verifiers harness.

Each rollout is one MST trial in the rollout's runtime:

1. Write a one-case dataset and an eval config whose servers are the task's MCP
   servers. These are MST's documented inputs.
2. Run `mst run --no-grade` with the client's inference pointed at verifiers'
   interception endpoint. MST resolves it in `resolveLLMEndpoint()`, as it does a
   gateway, so the client's model calls are the rollout's model calls.
3. Read the trial back (the `mst.run/v1` trial file), keep it in
   `trace.info["mst"]`, and return the client's final answer as the program's output.

MST owns the client: readiness, the run, the transcript and how the attempt
ended. verifiers owns everything else: the task, the interception, the trace and
the scores. See python/README.md in the MST repository.
"""

from __future__ import annotations

import base64
import json
import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, ClassVar, Literal

from pydantic import Field
from verifiers.v1.clients import ModelContext
from verifiers.v1.configs.harness import DialectName, HarnessConfig
from verifiers.v1.harness import Harness
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.task import TaskData
from verifiers.v1.trace import Trace

WORK_ROOT = ".vf-mst"
CASE_ID = "rollout"
DATASET_NAME = "verifiers"
# Clients whose options include `cwd`, so `workdir` can set it.
WORKDIR_CLIENTS = frozenset({"claude-code", "codex-cli"})
# Clients whose options include `systemPrompt`. Others get the system prompt folded
# into the input, as verifiers does for a harness that can't take one.
SYSTEM_PROMPT_CLIENTS = frozenset({"api", "claude-code", "codex-cli"})
# Clients that speak an OpenAI API, for `dialect = "auto"`. The rest speak Anthropic's.
OPENAI_CLIENTS = frozenset({"codex-cli"})
MAX_FILE_BYTES = 1_000_000

# Settings that would send the client's inference somewhere other than verifiers'
# endpoint, or authenticate it with something other than the rollout's secret. A
# subprocess runtime passes the host's environment through, so they are cleared: an
# empty value is unset for MST (`resolveLLMEndpoint`) and for the clients it starts.
_INFERENCE_OVERRIDES = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "MST_LLM_AUTH_COMMAND",
)

WriteMode = Literal["unguarded", "live", "read-only"]

# An MST version as (major, minor, patch, release, prerelease tag, prerelease number):
# `release` is 0 for a prerelease, so 2.0.0-rc.1 < 2.0.0.
MSTVersion = tuple[int, int, int, int, int, int]
_PRERELEASE_TAGS = {"alpha": 0, "beta": 1, "rc": 2}
# The first MST whose `mst.run/v1` trial file and `--no-report` this harness reads.
MIN_MST: MSTVersion = (2, 0, 0, 0, 2, 0)
# What an MST that predates an eval config's `writes` (ADR 0014) says about the key. Such
# an MST doesn't check writes either, so the harness reruns the trial without it. The
# version can't tell: MST's main branch took `writes` while still at 2.0.0-rc.0.
_WRITES_REJECTED = 'Unrecognized key: "writes"'


def parse_mst_version(output: str) -> MSTVersion | None:
    """The version `mst --version` prints, such as `2.0.0-rc.0`; None if unrecognized."""
    match = re.search(r"(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?", output)
    if match is None:
        return None
    major, minor, patch, tag, number = match.groups()
    if tag is None:
        return (int(major), int(minor), int(patch), 1, 0, 0)
    return (int(major), int(minor), int(patch), 0, _PRERELEASE_TAGS[tag], int(number))


def _format(version: MSTVersion) -> str:
    major, minor, patch, release, tag, number = version
    base = f"{major}.{minor}.{patch}"
    if release:
        return base
    name = next(n for n, rank in _PRERELEASE_TAGS.items() if rank == tag)
    return f"{base}-{name}.{number}"


class MSTHarnessConfig(HarnessConfig):
    id: str = "mst-harness"
    dialect: DialectName | Literal["auto"] = "auto"
    """The model API the client speaks, which decides whether MST gets the endpoint in
    ANTHROPIC_* or OPENAI_*. `auto`: `responses` for codex-cli, `anthropic_messages`
    for the other clients."""
    client: str = "claude-code"
    """The MST client, by its canonical name (`mst clients` lists them)."""
    client_options: dict[str, Any] = Field(default_factory=dict)
    """The client's options, as in an eval config's `clientOptions`."""
    plugins: list[str] = Field(default_factory=list)
    """MST plugins to load, for a plugin client."""
    writes: WriteMode = "unguarded"
    """The write mode of the task's servers. The taskset decides what reaches a service."""
    mst_command: list[str] = Field(default_factory=lambda: ["mst"])
    """How to start MST in the runtime, e.g. `["npx", "mst"]` or `["node", "/opt/mst/cli.js"]`."""
    workdir: list[str] | None = None
    """Run the client in a working directory the harness keeps, with these subdirectories
    created (for example `["answer"]`), and return the files it leaves there in
    `trace.info["mst"]["files"]`. Only for clients with a `cwd` option. Unset: the
    client's own default, an empty directory MST removes."""


class MSTHarness(Harness[MSTHarnessConfig]):
    APPENDS_SYSTEM_PROMPT: ClassVar[bool] = True
    SUPPORTS_MCP: ClassVar[bool] = True
    # MST isolates the clients it starts (a fresh config and working directory per
    # trial), so it runs on the subprocess runtime as well as in a container that has
    # MST installed.
    NEEDS_CONTAINER: ClassVar[bool] = False

    # Whether the runtime's MST takes an eval config's `writes`; False once it rejects it.
    _declares_writes: bool = True

    async def setup(self, runtime: Runtime) -> None:
        result = await runtime.run([*self.config.mst_command, "--version"], self._env())
        if result.exit_code != 0:
            detail = (result.stderr or result.stdout).strip()[-500:]
            raise RuntimeError(
                f"MST didn't start in the runtime with {shlex.join(self.config.mst_command)}: "
                f"{detail or 'no output'}. Install @gleanwork/mcp-server-tester in the runtime, "
                "or set mst_command."
            )
        version = parse_mst_version(result.stdout)
        if version is not None and version < MIN_MST:
            raise RuntimeError(
                f"mst-harness needs MST {_format(MIN_MST)} or later; the runtime has "
                f"{result.stdout.strip()}."
            )

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace[Any, Any, Any],
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
        data: TaskData,
    ) -> ProgramResult:
        system_prompt, prompt = self.resolve_text_prompt(data)
        work = f"{WORK_ROOT}/{trace.id}"
        client_options = dict(self.config.client_options)
        workdir = f"{work}/workdir"
        if self.config.workdir is not None:
            if self.config.client not in WORKDIR_CLIENTS:
                raise ValueError(
                    f"workdir needs a client with a `cwd` option "
                    f"({', '.join(sorted(WORKDIR_CLIENTS))}), not {self.config.client}"
                )
            dirs = [workdir, *(f"{workdir}/{d.strip('/')}" for d in self.config.workdir)]
            made = await runtime.run(["mkdir", "-p", *dirs], {})
            if made.exit_code != 0:
                raise RuntimeError(f"Couldn't create the client's workdir: {made.stderr.strip()}")
            client_options.setdefault("cwd", workdir)
        request = TrialRequest(
            client=self.config.client,
            model=ctx.model,
            prompt=prompt or "",
            system_prompt=system_prompt,
            mcp_urls=mcp_urls,
            client_options=client_options,
            plugins=tuple(self.config.plugins),
            writes=self.config.writes if self._declares_writes else None,
            name=f"verifiers-{trace.id}",
        )
        await runtime.write(f"{work}/dataset.json", _json(dataset(request)))
        await runtime.write(f"{work}/eval.json", _json(eval_config(request, "dataset.json")))

        argv = [
            *self.config.mst_command,
            "run",
            "--config",
            f"{work}/eval.json",
            "--output-dir",
            f"{work}/results",
            "--no-grade",
            "--no-report",
        ]
        ran = await runtime.run(argv, self._env(endpoint, secret))
        trial_path = await self._trial_path(runtime, f"{work}/results")
        if (
            trial_path is None
            and request.writes is not None
            and _WRITES_REJECTED in f"{ran.stdout}\n{ran.stderr}"
        ):
            # MST rejected the config before starting the client, so nothing ran.
            self._declares_writes = False
            request = replace(request, writes=None)
            await runtime.write(f"{work}/eval.json", _json(eval_config(request, "dataset.json")))
            ran = await runtime.run(argv, self._env(endpoint, secret))
            trial_path = await self._trial_path(runtime, f"{work}/results")
        if trial_path is None:
            detail = (ran.stderr or ran.stdout).strip()[-2000:]
            return ProgramResult(
                ran.exit_code or 1,
                ran.stdout,
                f"MST wrote no trial for the rollout: {detail or 'no output'}",
            )
        result = parse_trial(await runtime.read(trial_path))
        trace.info["mst"] = {"client": self.config.client, **result.info()}
        if self.config.workdir is not None:
            trace.info["mst"]["files"] = await _collect_files(runtime, workdir)
        if not result.collected:
            return ProgramResult(
                1,
                result.final_text,
                f"MST's {self.config.client} trial ended in an infrastructure failure "
                f"({result.failure})",
            )
        if result.model_calls and not trace.calls:
            # The client reached a model, but not through verifiers: its own settings (for
            # example Claude Code's managed settings) pinned another endpoint. The trace
            # would hold no model calls and score an empty reply, so fail the rollout.
            return ProgramResult(
                1,
                result.final_text,
                f"MST's {self.config.client} client made {result.model_calls} model calls, "
                "none through verifiers' endpoint. Its own settings route inference "
                "elsewhere (for Claude Code, check managed settings' ANTHROPIC_BASE_URL); "
                "use a client that takes the endpoint from its environment, such as `api`.",
            )
        if result.error and not result.model_calls and not trace.calls:
            # The client failed before it reached the model (for example, a missing
            # package): nothing the model did is there to score.
            return ProgramResult(
                1,
                result.final_text,
                f"MST's {self.config.client} client failed before any model call: {result.error}",
            )
        # A trial is graded even when the client errored after reaching the model
        # (MST's ADR 0010); verifiers scores it.
        return ProgramResult(0, result.final_text, ran.stderr)

    def _env(self, endpoint: str | None = None, secret: str | None = None) -> dict[str, str]:
        env = {**self.config.resolved_env}
        if endpoint is None or secret is None:
            return env
        env.update(dict.fromkeys(_INFERENCE_OVERRIDES, ""))
        if self.api_dialect == "anthropic_messages":
            # The Anthropic base URL is the API root: clients append /v1/messages.
            env["ANTHROPIC_BASE_URL"] = endpoint.removesuffix("/").removesuffix("/v1")
            env["ANTHROPIC_API_KEY"] = secret
        else:
            env["OPENAI_BASE_URL"] = endpoint
            env["OPENAI_API_KEY"] = secret
        return env

    @property
    def api_dialect(self) -> DialectName:
        """The configured dialect, with `auto` resolved from the client."""
        if self.config.dialect != "auto":
            return self.config.dialect
        return "responses" if self.config.client in OPENAI_CLIENTS else "anthropic_messages"

    @staticmethod
    async def _trial_path(runtime: Runtime, results: str) -> str | None:
        found = await runtime.run(
            # `transcripts/` since MST 2.0.0-rc.1, `traces/` before.
            [
                "sh",
                "-c",
                f"ls {shlex.quote(results)}/runs/*/transcripts/*/*/*.json "
                f"{shlex.quote(results)}/runs/*/traces/*/*/*.json 2>/dev/null",
            ],
            {},
        )
        paths = [line for line in found.stdout.splitlines() if line.strip()]
        return paths[-1] if paths else None


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
    writes: WriteMode | None = "unguarded"
    """None: leave `writes` out, for an MST that predates it."""
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
    the taskset's to handle, so they are declared `unguarded` by default: MST can't
    see them and doesn't stop them. Transcripts are stored unredacted so the harness
    can return them.
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
    if servers and request.writes not in (None, "read-only"):
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
    """Read MST's trial file (`transcripts/<variant>/<case>/<trial>.json`).

    MST 2.0.0-rc.0 names the transcript `trace` (in `traces/`), and records no model calls.
    """
    raw = json.loads(data)
    if not isinstance(raw, dict):
        raise ValueError("MST's trial file is not a JSON object")
    trial: dict[str, Any] = raw
    transcript = trial.get("transcript", trial.get("trace"))
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


async def _collect_files(runtime: Runtime, root: str) -> dict[str, dict[str, Any]]:
    """The files under `root`, by relative path: text when it decodes, else base64."""
    found = await runtime.run(["sh", "-c", f"cd {shlex.quote(root)} && find . -type f -print"], {})
    files: dict[str, dict[str, Any]] = {}
    for line in sorted(found.stdout.splitlines()):
        relative = line.strip().removeprefix("./")
        if not relative:
            continue
        content = await runtime.read(f"{root}/{relative}")
        if len(content) > MAX_FILE_BYTES:
            files[relative] = {"size": len(content), "omitted": "larger than the harness keeps"}
            continue
        try:
            files[relative] = {"size": len(content), "text": content.decode()}
        except UnicodeDecodeError:
            files[relative] = {"size": len(content), "base64": base64.b64encode(content).decode()}
    return files


def _json(value: object) -> bytes:
    return (json.dumps(value, indent=2) + "\n").encode()

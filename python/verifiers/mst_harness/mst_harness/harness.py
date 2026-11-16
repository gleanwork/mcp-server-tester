"""Run an MST client as a verifiers harness.

Each rollout is one MST trial in the rollout's runtime:

1. Write a one-case dataset and an eval config whose servers are the task's MCP
   servers. These are MST's documented inputs.
2. Run `mst run --no-grade` with the client's inference pointed at verifiers'
   interception endpoint. MST resolves it in `resolveLLMEndpoint()`, as it does a
   gateway, so the client's model calls are the rollout's model calls.
3. Read the trial back (the `mst.run/v1` trial file), keep it in
   `trace.info["mst"]`, and return the client's final answer as the program's output.

MST owns the client. verifiers owns the task, the interception, the trace and the
scores. The harness uses MST only through its CLI.
"""

from __future__ import annotations

import base64
import json
import shlex
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, ClassVar, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import Field
from verifiers.v1.clients import ModelContext
from verifiers.v1.harness import Harness, HarnessConfig
from verifiers.v1.runtimes import DockerRuntime, ProgramResult, Runtime
from verifiers.v1.trace import Trace

from mst_harness import cowork_container

WORK_ROOT = ".vf-mst"
CASE_ID = "rollout"
DATASET_NAME = "verifiers"
# Clients whose options include `cwd`, so `workdir` can set it.
WORKDIR_CLIENTS = frozenset({"claude-code", "codex-cli"})
# Clients whose options include `systemPrompt`. Others get the system prompt folded
# into the input.
SYSTEM_PROMPT_CLIENTS = frozenset({"api", "claude-code", "codex-cli"})
# Clients that speak an OpenAI API. The rest speak Anthropic's Messages API.
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
# What an MST that predates an eval config's `writes` (2.0.0-rc.0) says about the key.
# Such an MST doesn't check writes either, so the harness reruns the trial without it.
_WRITES_REJECTED = 'Unrecognized key: "writes"'

WriteMode = Literal["unguarded", "live", "read-only"]


class MSTHarnessConfig(HarnessConfig):
    id: str = "mst-harness"
    client: str = "claude-code"
    """The MST client, by its canonical name (`mst clients` lists them)."""
    client_options: dict[str, Any] = Field(default_factory=dict)
    """The client's options, as in an eval config's `clientOptions`."""
    writes: WriteMode = "unguarded"
    """The write mode of the task's servers. The taskset decides what reaches a service."""
    mst_command: list[str] = Field(default_factory=lambda: ["mst"])
    """How to start MST in the runtime, e.g. `["npx", "mst"]` or `["node", "/opt/mst/cli.js"]`."""
    eval_config: dict[str, Any] = Field(default_factory=dict)
    """More eval config keys, such as `timeout` or `coworkSetup`. The harness's own keys
    (datasets, servers, client, model) win."""
    mst_args: list[str] = Field(default_factory=list)
    """More arguments for `mst run`, e.g. `["--runner", "docker", "--runner-option",
    "contexts=colima-mst-kvm"]` to run Cowork in MST's Linux image."""
    host_alias: str | None = None
    """The host name the client reaches this machine's loopback at, when MST runs the
    client in a container of its own (`--runner docker`): for example
    `host.docker.internal`. The endpoint's and MCP servers' loopback hosts become it.
    Unset: the URLs are passed unchanged."""
    cowork_container: bool = False
    """Run Cowork in the rollout's Docker runtime, whose image is MST's Cowork Linux
    image (`mst-cowork-linux`). The harness restarts the runtime's container with
    Cowork's VM devices, forwards the endpoint's and MCP servers' ports to the
    container's loopback, and runs `mst run` there (`cowork_container.py`). Cowork's VM
    takes a host-wide vsock port: run one rollout at a time per Docker host."""
    seccomp: str = "unconfined"
    """The Cowork container's seccomp profile: a path to one (MST's is
    `docker/cowork-linux/seccomp.json`), or `unconfined`."""
    ready_timeout_s: float = 1200
    """How long the Cowork container's desktop has to come up."""
    workdir: list[str] | None = None
    """Run the client in a working directory the harness keeps, with these subdirectories
    created (for example `["answer"]`), and return the files it leaves there in
    `trace.info["mst"]["files"]`. Only for clients with a `cwd` option. Unset: the
    client's own default, an empty directory MST removes."""


class MSTHarness(Harness[MSTHarnessConfig]):
    APPENDS_SYSTEM_PROMPT: ClassVar[bool] = True
    SUPPORTS_MCP: ClassVar[bool] = True

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

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace[Any, Any],
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        system_prompt, prompt = self.resolve_prompt(trace.task.data)
        if prompt is not None and not isinstance(prompt, str):
            raise ValueError("mst-harness takes a text prompt, not messages.")
        work = f"{WORK_ROOT}/{trace.id}"
        in_container = self.config.cowork_container
        if in_container:
            if not isinstance(runtime, DockerRuntime):
                raise ValueError("cowork_container needs a Docker runtime.")
            if self.config.client != "cowork":
                raise ValueError(f"cowork_container runs Cowork, not {self.config.client}.")
            forwarding = cowork_container.forward_to_loopback(
                endpoint, mcp_urls, self.config.host_alias
            )
            await cowork_container.start_cowork_container(
                runtime,
                forwarding=forwarding,
                secret=secret,
                model=ctx.model,
                host=self.config.host_alias or "host.docker.internal",
                seccomp=self.config.seccomp,
                ready_timeout_s=self.config.ready_timeout_s,
            )
            endpoint, mcp_urls = forwarding.endpoint, forwarding.mcp_urls
        elif self.config.host_alias:
            endpoint = via_host(endpoint, self.config.host_alias)
            mcp_urls = {
                name: via_host(url, self.config.host_alias) for name, url in mcp_urls.items()
            }
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
            pwd = await runtime.run(["sh", "-c", f"cd {shlex.quote(workdir)} && pwd"], {})
            workdir = pwd.stdout.strip() or workdir
            client_options.setdefault("cwd", workdir)
        request = TrialRequest(
            client=self.config.client,
            model=ctx.model,
            prompt=prompt or "",
            system_prompt=system_prompt,
            mcp_urls=mcp_urls,
            client_options=client_options,
            writes=self.config.writes if self._declares_writes else None,
            name=f"verifiers-{trace.id}",
            extra=self.config.eval_config,
        )
        await runtime.write(f"{work}/dataset.json", _json(dataset(request)))
        await runtime.write(f"{work}/eval.json", _json(eval_config(request, "dataset.json")))
        if in_container:
            assert isinstance(runtime, DockerRuntime)
            await cowork_container.give_to_desktop_user(runtime, work)

        argv = [
            *self.config.mst_command,
            "run",
            "--config",
            f"{work}/eval.json",
            "--output-dir",
            f"{work}/results",
            "--no-grade",
            "--no-report",
            *self.config.mst_args,
        ]
        ran = await self._run_mst(runtime, argv, self._env(endpoint, secret))
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
            ran = await self._run_mst(runtime, argv, self._env(endpoint, secret))
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
        artifacts = result.raw.get("artifacts")
        if isinstance(artifacts, str):
            # The client's files MST kept (Cowork's session folder), relative to the run.
            run_dir = trial_path.rsplit("/transcripts/", 1)[0].rsplit("/traces/", 1)[0]
            trace.info["mst"]["artifacts"] = f"{run_dir}/{artifacts}"
        if self.config.workdir is not None:
            trace.info["mst"]["files"] = await collect_files(runtime, workdir)
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
        # A trial is graded even when the client errored after reaching the model;
        # verifiers scores it.
        return ProgramResult(0, result.final_text, ran.stderr)

    async def _run_mst(
        self, runtime: Runtime, argv: list[str], env: dict[str, str]
    ) -> ProgramResult:
        if self.config.cowork_container and isinstance(runtime, DockerRuntime):
            # No warm-up task when MST restarts the desktop: it would be a model call
            # through the rollout's endpoint, in the rollout's trace. The rollout's own
            # task boots Cowork's VM instead.
            env = {**env, "MST_COWORK_WARM_VM": "0"}
            return await cowork_container.run_as_desktop_user(runtime, argv, env)
        return await runtime.run(argv, env)

    def _env(self, endpoint: str | None = None, secret: str | None = None) -> dict[str, str]:
        env = {**self.config.resolved_env}
        if endpoint is None or secret is None:
            return env
        env.update(dict.fromkeys(_INFERENCE_OVERRIDES, ""))
        if self.config.client in OPENAI_CLIENTS:
            env["OPENAI_BASE_URL"] = endpoint
            env["OPENAI_API_KEY"] = secret
        else:
            # The Anthropic base URL is the API root: clients append /v1/messages.
            env["ANTHROPIC_BASE_URL"] = endpoint.removesuffix("/").removesuffix("/v1")
            env["ANTHROPIC_API_KEY"] = secret
        return env

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


def via_host(url: str, host: str) -> str:
    """`url` with a loopback host (127.0.0.1, localhost, [::1]) replaced by `host`."""
    parts = urlsplit(url)
    if parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return url
    netloc = host if parts.port is None else f"{host}:{parts.port}"
    return urlunsplit(parts._replace(netloc=netloc))


@dataclass(frozen=True)
class TrialRequest:
    """What one rollout asks MST to run."""

    client: str
    model: str
    prompt: str
    mcp_urls: Mapping[str, str]
    system_prompt: str | None = None
    client_options: Mapping[str, Any] | None = None
    writes: WriteMode | None = "unguarded"
    """None: leave `writes` out, for an MST that predates it."""
    name: str = "verifiers-rollout"
    extra: Mapping[str, Any] | None = None
    """More eval config keys; the request's own win."""


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
        **(request.extra or {}),
        "name": request.name,
        "datasets": [{"type": "file", "path": dataset_path}],
        "servers": servers,
        "client": request.client,
        "model": request.model,
        "redactStoredResponses": False,
    }
    if options:
        config["clientOptions"] = options
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

    MST 2.0.0-rc.0 names the transcript `trace` (in `traces/`).
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


async def list_files(runtime: Runtime, root: str) -> list[str]:
    """The regular files under `root`, as sorted relative paths."""
    found = await runtime.run(
        ["sh", "-c", f"cd {shlex.quote(root)} 2>/dev/null && find . -type f -print"], {}
    )
    return sorted(
        path
        for path in (line.strip().removeprefix("./") for line in found.stdout.splitlines())
        if path
    )


async def collect_files(runtime: Runtime, root: str) -> dict[str, dict[str, Any]]:
    """The files under `root`, by relative path: text when it decodes, else base64."""
    files: dict[str, dict[str, Any]] = {}
    for relative in await list_files(runtime, root):
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

"""MST clients as verifiers harnesses.

Each rollout runs one MST trial in the rollout's runtime:

1. Write a one-case dataset and an eval config whose servers are the task's MCP
   servers (`trial.py`).
2. Run `mst run --no-grade` with the client's inference pointed at verifiers'
   interception endpoint. MST resolves it in `resolveLLMEndpoint()`, as it does a
   gateway, so the client's model calls are the rollout's model calls.
3. Read the trial file back, keep it in `trace.info["mst"]`, and return the
   client's final answer as the program's output.

MST owns the client: readiness, the run, the transcript and how the attempt
ended. verifiers owns everything else: the task, the interception, the trace and
the scores. See docs/verifiers.md and ADR 0015.
"""

from __future__ import annotations

import base64
import json
import shlex
from typing import Any, ClassVar, Literal

from pydantic import Field
from verifiers.v1.clients import ModelContext
from verifiers.v1.harness import Harness, HarnessConfig
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace

from mst_harness.trial import TrialRequest, WriteMode, dataset, eval_config, parse_trial

WORK_ROOT = ".vf-mst"
# Clients whose options include `cwd`, so `harness.workdir` can set it.
WORKDIR_CLIENTS = frozenset({"claude-code", "codex-cli"})
MAX_FILE_BYTES = 1_000_000

# Settings that would send the client's inference somewhere other than verifiers'
# endpoint, or authenticate it with something other than the rollout's secret. A
# subprocess runtime inherits the host's environment, so they are cleared: an empty
# value is unset for MST (`resolveLLMEndpoint`) and for the clients it starts.
_INFERENCE_OVERRIDES = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "MST_LLM_AUTH_COMMAND",
)


class MSTHarnessConfig(HarnessConfig):
    id: str = "mst-harness"
    client: str = "claude-code"
    """The MST client, by its canonical name (`mst clients` lists them)."""
    client_options: dict[str, Any] = Field(default_factory=dict)
    """The client's options, as in an eval config's `clientOptions`."""
    plugins: list[str] = Field(default_factory=list)
    """MST plugins to load, for a plugin client."""
    api: Literal["anthropic", "openai"] = "anthropic"
    """The API family the client's inference speaks to verifiers' endpoint."""
    writes: WriteMode = "unguarded"
    """The write mode of the task's servers. The taskset's proxy owns their writes."""
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

    async def setup(self, runtime: Runtime) -> None:
        result = await runtime.run([*self.config.mst_command, "--version"], self._env())
        if result.exit_code != 0:
            detail = (result.stderr or result.stdout).strip()[-500:]
            raise RuntimeError(
                f"MST didn't start in the runtime with {shlex.join(self.config.mst_command)}: "
                f"{detail or 'no output'}. Install @gleanwork/mcp-server-tester in the runtime, "
                "or set harness.mst_command."
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
        if not isinstance(prompt, str):
            raise ValueError("MST runs a task whose prompt is a string")
        work = f"{WORK_ROOT}/{trace.id}"
        client_options = dict(self.config.client_options)
        workdir = f"{work}/workdir"
        if self.config.workdir is not None:
            if self.config.client not in WORKDIR_CLIENTS:
                raise ValueError(
                    f"harness.workdir needs a client with a `cwd` option "
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
            prompt=prompt,
            system_prompt=system_prompt,
            mcp_urls=mcp_urls,
            client_options=client_options,
            plugins=tuple(self.config.plugins),
            writes=self.config.writes,
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
        ran = await runtime.run_program(argv, self._env(endpoint, secret))

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
        # A trial is graded even when the client errored (ADR 0010); verifiers scores it.
        return ProgramResult(0, result.final_text, ran.stderr)

    def _env(self, endpoint: str | None = None, secret: str | None = None) -> dict[str, str]:
        env = {**self.config.resolved_env}
        if endpoint is None or secret is None:
            return env
        env.update(dict.fromkeys(_INFERENCE_OVERRIDES, ""))
        if self.config.api == "anthropic":
            # The Anthropic base URL is the API root: clients append /v1/messages.
            env["ANTHROPIC_BASE_URL"] = endpoint.removesuffix("/").removesuffix("/v1")
            env["ANTHROPIC_API_KEY"] = secret
        else:
            env["OPENAI_BASE_URL"] = endpoint
            env["OPENAI_API_KEY"] = secret
        return env

    @staticmethod
    async def _trial_path(runtime: Runtime, results: str) -> str | None:
        found = await runtime.run(
            ["sh", "-c", f"ls {shlex.quote(results)}/runs/*/transcripts/*/*/*.json 2>/dev/null"],
            {},
        )
        paths = [line for line in found.stdout.splitlines() if line.strip()]
        return paths[-1] if paths else None


async def _collect_files(runtime: Runtime, root: str) -> dict[str, dict[str, Any]]:
    """The files under `root`, by relative path: text when it decodes, else base64."""
    found = await runtime.run(["sh", "-c", f"cd {shlex.quote(root)} && find . -type f -print"], {})
    files: dict[str, dict[str, Any]] = {}
    for line in sorted(found.stdout.splitlines()):
        relative = line.strip().removeprefix("./")
        if not relative:
            continue
        data = await runtime.read(f"{root}/{relative}")
        if len(data) > MAX_FILE_BYTES:
            files[relative] = {"size": len(data), "omitted": "larger than the harness keeps"}
            continue
        try:
            files[relative] = {"size": len(data), "text": data.decode()}
        except UnicodeDecodeError:
            files[relative] = {"size": len(data), "base64": base64.b64encode(data).decode()}
    return files


def _json(value: object) -> bytes:
    return (json.dumps(value, indent=2) + "\n").encode()

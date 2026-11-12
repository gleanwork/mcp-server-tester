from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, cast

import pytest
from verifiers.v1.clients import ModelContext
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace

from mst_harness import MSTHarness, MSTHarnessConfig
from mst_harness.trial import TrialRequest, dataset, eval_config, parse_trial

ENDPOINT = "http://127.0.0.1:8765/rollout/abc/v1"


def trial_file(**overrides: Any) -> bytes:
    trial: dict[str, Any] = {
        "format": 1,
        "kind": "trial",
        "caseId": "rollout",
        "variant": "default",
        "trial": 1,
        "ending": {"kind": "trial"},
        "infrastructureError": False,
        "transcript": {
            "finalText": "The answer.",
            "events": [{"kind": "tool_call", "name": "search"}],
            "evidence": "structured",
            "modelCalls": [{"id": "msg_1"}],
        },
    }
    trial.update(overrides)
    return json.dumps(trial).encode()


class FakeRuntime:
    """Records what the harness writes and runs; serves one trial file."""

    def __init__(self, trial: bytes | None, exit_code: int = 0) -> None:
        self.trial = trial
        self.exit_code = exit_code
        self.files: dict[str, bytes] = {}
        self.runs: list[tuple[list[str], dict[str, str]]] = []
        self.programs: list[tuple[list[str], dict[str, str]]] = []

    async def write(self, path: str, data: bytes) -> None:
        self.files[path] = data

    async def read(self, path: str) -> bytes:
        if path in self.files:
            return self.files[path]
        assert self.trial is not None
        return self.trial

    async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        self.runs.append((argv, env))
        if argv[0] == "sh" and "find . -type f" in argv[2]:
            root = argv[2].split("cd ", 1)[1].split(" &&", 1)[0]
            listed = [f"./{p.removeprefix(root + '/')}" for p in self.files if p.startswith(root)]
            return ProgramResult(0, "\n".join(listed) + "\n", "")
        if argv[0] == "sh" and self.trial is not None:
            return ProgramResult(0, "results/runs/r1/transcripts/default/rollout/1.json\n", "")
        return ProgramResult(0, "", "")

    async def run_program(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        self.programs.append((argv, env))
        return ProgramResult(self.exit_code, "mst summary", "mst log")


AnyTrace = Trace[Any, Any]


def fake_trace(
    prompt: str = "Write the brief.",
    system_prompt: str | None = None,
    calls: list[object] | None = None,
) -> AnyTrace:
    """A trace whose interception recorded `calls` (one model call by default)."""
    task = SimpleNamespace(data=SimpleNamespace(prompt=prompt, system_prompt=system_prompt))
    recorded = [object()] if calls is None else calls
    return cast(AnyTrace, SimpleNamespace(id="t-1", task=task, info={}, calls=recorded))


def harness(**config: Any) -> MSTHarness:
    return MSTHarness(MSTHarnessConfig(**config))


async def launch(h: MSTHarness, runtime: FakeRuntime, trace: AnyTrace) -> ProgramResult:
    ctx = cast(ModelContext, SimpleNamespace(model="claude-sonnet-4-6"))
    return await h.launch(
        ctx, trace, cast(Runtime, runtime), ENDPOINT, "secret-1", {"acme": "http://x/mcp/acme"}
    )


def test_eval_config_maps_servers_model_and_writes() -> None:
    request = TrialRequest(
        client="cowork",
        model="claude-sonnet-4-6",
        prompt="Do it.",
        mcp_urls={"acme": "http://x/mcp/acme"},
        client_options={"toolSearch": False},
    )
    config = eval_config(request, "dataset.json")
    assert config["servers"] == {"acme": {"transport": "http", "serverUrl": "http://x/mcp/acme"}}
    assert config["client"] == "cowork"
    assert config["model"] == "claude-sonnet-4-6"
    assert config["clientOptions"] == {"toolSearch": False}
    assert config["writes"] == {"acme": "unguarded"}
    assert config["redactStoredResponses"] is False


def test_system_prompt_is_an_option_or_folded_into_the_input() -> None:
    def request(client: str) -> TrialRequest:
        return TrialRequest(
            client=client, model="m", prompt="Do it.", mcp_urls={}, system_prompt="Be brief."
        )

    with_option = request("claude-code")
    assert eval_config(with_option, "d.json")["clientOptions"] == {"systemPrompt": "Be brief."}
    assert dataset(with_option)["cases"][0]["input"] == "Do it."

    folded = request("cowork")
    assert "clientOptions" not in eval_config(folded, "d.json")
    assert dataset(folded)["cases"][0]["input"] == "Be brief.\n\nDo it."


def test_an_empty_prompt_is_rejected() -> None:
    with pytest.raises(ValueError, match="empty"):
        dataset(TrialRequest(client="api", model="m", prompt="  ", mcp_urls={}))


def test_parse_trial_reads_the_answer_and_ending() -> None:
    result = parse_trial(trial_file())
    assert result.final_text == "The answer."
    assert result.collected
    assert result.info()["evidence"] == "structured"


async def test_launch_runs_one_trial_against_the_interception_endpoint() -> None:
    runtime = FakeRuntime(trial_file())
    trace = fake_trace()
    result = await launch(harness(env={"KEEP": "1"}), runtime, trace)

    assert result.exit_code == 0
    assert result.stdout == "The answer."
    argv, env = runtime.programs[0]
    assert argv[:4] == ["mst", "run", "--config", ".vf-mst/t-1/eval.json"]
    assert "--no-grade" in argv
    assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8765/rollout/abc"
    assert env["ANTHROPIC_API_KEY"] == "secret-1"
    assert env["MST_LLM_AUTH_COMMAND"] == ""
    assert env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert env["KEEP"] == "1"
    written = json.loads(runtime.files[".vf-mst/t-1/eval.json"])
    assert written["servers"]["acme"]["serverUrl"] == "http://x/mcp/acme"
    assert trace.info["mst"]["client"] == "claude-code"
    assert trace.info["mst"]["transcript"]["events"][0]["name"] == "search"


async def test_workdir_runs_the_client_there_and_returns_its_files() -> None:
    runtime = FakeRuntime(trial_file())
    runtime.files[".vf-mst/t-1/workdir/answer/report.md"] = b"# Report\n"
    trace = fake_trace()
    h = harness(client="codex-cli", api="openai", workdir=["answer"])
    result = await launch(h, runtime, trace)

    assert result.exit_code == 0
    mkdir = next(argv for argv, _ in runtime.runs if argv[0] == "mkdir")
    assert mkdir[2:] == [".vf-mst/t-1/workdir", ".vf-mst/t-1/workdir/answer"]
    written = json.loads(runtime.files[".vf-mst/t-1/eval.json"])
    assert written["clientOptions"]["cwd"] == ".vf-mst/t-1/workdir"
    assert trace.info["mst"]["files"] == {"answer/report.md": {"size": 9, "text": "# Report\n"}}


async def test_workdir_needs_a_client_with_a_cwd_option() -> None:
    with pytest.raises(ValueError, match="cwd"):
        await launch(
            harness(client="api", workdir=["answer"]), FakeRuntime(trial_file()), fake_trace()
        )


async def test_launch_routes_openai_clients_to_the_openai_variables() -> None:
    runtime = FakeRuntime(trial_file())
    await launch(harness(client="codex-cli", api="openai"), runtime, fake_trace())
    env = runtime.programs[0][1]
    assert env["OPENAI_BASE_URL"] == ENDPOINT
    assert env["OPENAI_API_KEY"] == "secret-1"
    assert env["ANTHROPIC_BASE_URL"] == ""


async def test_an_infrastructure_failure_fails_the_rollout() -> None:
    ending = {
        "kind": "infrastructure",
        "broke": "client-app",
        "retryable": True,
        "reason": "Claude Desktop crashed",
    }
    runtime = FakeRuntime(trial_file(ending=ending, infrastructureError=True), exit_code=1)
    trace = fake_trace()
    result = await launch(harness(client="cowork"), runtime, trace)
    assert result.exit_code == 1
    assert "infrastructure failure (client-app: Claude Desktop crashed)" in result.stderr
    assert trace.info["mst"]["ending"] == ending


async def test_model_calls_that_bypass_verifiers_fail_the_rollout() -> None:
    runtime = FakeRuntime(trial_file())
    result = await launch(harness(), runtime, fake_trace(calls=[]))
    assert result.exit_code == 1
    assert "none through verifiers' endpoint" in result.stderr


async def test_no_trial_file_names_mst_output() -> None:
    runtime = FakeRuntime(None, exit_code=2)
    result = await launch(harness(), runtime, fake_trace())
    assert result.exit_code == 2
    assert "MST wrote no trial" in result.stderr
    assert "mst log" in result.stderr


async def test_setup_names_the_command_when_mst_is_missing() -> None:
    class Missing(FakeRuntime):
        async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
            return ProgramResult(127, "", "mst: not found")

    with pytest.raises(RuntimeError, match=r"harness\.mst_command"):
        await harness(mst_command=["npx", "mst"]).setup(cast(Runtime, Missing(None)))


def test_verifiers_loads_the_package_as_a_harness() -> None:
    from verifiers.v1.loaders import harness_class, harness_config_type

    assert harness_class("mst-harness") is MSTHarness
    assert harness_config_type("mst-harness") is MSTHarnessConfig

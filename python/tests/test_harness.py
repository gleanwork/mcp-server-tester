from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, cast

import pytest
from verifiers.v1.clients import ModelContext
from verifiers.v1.loaders import harness_class, harness_config_type
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.task import TaskData
from verifiers.v1.trace import Trace

from mst_harness import MSTHarness, MSTHarnessConfig, cowork_container
from mst_harness.harness import (
    TrialRequest,
    dataset,
    eval_config,
    parse_trial,
)

ENDPOINT = "http://127.0.0.1:8765/rollout/abc/v1"
# The runtime's working directory, where relative paths resolve.
CWD = "/app"


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

    async def write(self, path: str, data: bytes) -> None:
        self.files[path] = data

    async def read(self, path: str, max_bytes: int | None = None) -> bytes:
        path = path.removeprefix(f"{CWD}/")
        if path in self.files:
            return self.files[path]
        assert self.trial is not None
        return self.trial

    async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        self.runs.append((argv, env))
        if argv[:2] == ["mst", "run"]:
            return ProgramResult(self.exit_code, "mst summary", "mst log")
        if argv[0] == "sh" and argv[2].endswith("&& pwd"):
            return ProgramResult(0, f"{CWD}/{argv[2].split('cd ', 1)[1].split(' &&', 1)[0]}\n", "")
        if argv[0] == "sh" and "find . -type f" in argv[2]:
            root = argv[2].split("cd ", 1)[1].split(" ", 1)[0].removeprefix(f"{CWD}/")
            listed = [f"./{p.removeprefix(root + '/')}" for p in self.files if p.startswith(root)]
            return ProgramResult(0, "\n".join(listed) + "\n", "")
        if argv[0] == "sh" and self.trial is not None:
            return ProgramResult(0, "results/runs/r1/transcripts/default/rollout/1.json\n", "")
        return ProgramResult(0, "", "")

    def mst_run(self) -> tuple[list[str], dict[str, str]]:
        return next((argv, env) for argv, env in self.runs if argv[:2] == ["mst", "run"])


AnyTrace = Trace[Any, Any]


def task_data(**fields: Any) -> TaskData:
    return TaskData.model_validate({"idx": 0, **fields})


def fake_trace(calls: list[object] | None = None, data: TaskData | None = None) -> AnyTrace:
    """A trace whose interception recorded `calls` (one model call by default)."""
    recorded = [object()] if calls is None else calls
    task = SimpleNamespace(data=data or task_data(prompt="Write the brief."))
    return cast(AnyTrace, SimpleNamespace(id="t-1", info={}, calls=recorded, task=task))


def harness(**config: Any) -> MSTHarness:
    return MSTHarness(MSTHarnessConfig(**config))


async def launch(h: MSTHarness, runtime: FakeRuntime, trace: AnyTrace) -> ProgramResult:
    ctx = cast(ModelContext, SimpleNamespace(model="claude-sonnet-4-6"))
    return await h.launch(
        ctx,
        trace,
        cast(Runtime, runtime),
        ENDPOINT,
        "secret-1",
        {"acme": "http://x/mcp/acme"},
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
    trace = fake_trace(data=task_data(prompt="Write the brief.", system_prompt="Be brief."))
    result = await launch(harness(env={"KEEP": "1"}), runtime, trace)

    assert result.exit_code == 0
    assert result.stdout == "The answer."
    argv, env = runtime.mst_run()
    assert argv[:4] == ["mst", "run", "--config", ".vf-mst/t-1/eval.json"]
    assert "--no-grade" in argv
    assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8765/rollout/abc"
    assert env["ANTHROPIC_API_KEY"] == "secret-1"
    assert env["MST_LLM_AUTH_COMMAND"] == ""
    assert env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert env["KEEP"] == "1"
    written = json.loads(runtime.files[".vf-mst/t-1/eval.json"])
    assert written["servers"]["acme"]["serverUrl"] == "http://x/mcp/acme"
    assert written["clientOptions"] == {"systemPrompt": "Be brief."}
    cases = json.loads(runtime.files[".vf-mst/t-1/dataset.json"])["cases"]
    assert cases == [{"id": "rollout", "input": "Write the brief."}]
    assert trace.info["mst"]["client"] == "claude-code"
    assert trace.info["mst"]["transcript"]["events"][0]["name"] == "search"


async def test_workdir_runs_the_client_there_and_returns_its_files() -> None:
    runtime = FakeRuntime(trial_file())
    runtime.files[".vf-mst/t-1/workdir/answer/report.md"] = b"# Report\n"
    trace = fake_trace()
    h = harness(client="codex-cli", workdir=["answer"])
    result = await launch(h, runtime, trace)

    assert result.exit_code == 0
    mkdir = next(argv for argv, _ in runtime.runs if argv[0] == "mkdir")
    assert mkdir[2:] == [".vf-mst/t-1/workdir", ".vf-mst/t-1/workdir/answer"]
    written = json.loads(runtime.files[".vf-mst/t-1/eval.json"])
    assert written["clientOptions"]["cwd"] == "/app/.vf-mst/t-1/workdir"
    assert trace.info["mst"]["files"] == {"answer/report.md": {"size": 9, "text": "# Report\n"}}


async def test_a_containerized_client_reaches_loopback_through_the_host_alias() -> None:
    runtime = FakeRuntime(trial_file())
    h = harness(client="cowork", host_alias="host.docker.internal", mst_args=["--runner", "docker"])
    ctx = cast(ModelContext, SimpleNamespace(model="claude-sonnet-4-6"))
    await h.launch(
        ctx,
        fake_trace(),
        cast(Runtime, runtime),
        ENDPOINT,
        "secret-1",
        {"tools": "http://127.0.0.1:9001/mcp", "remote": "https://mcp.example.com/mcp"},
    )

    argv, env = runtime.mst_run()
    assert argv[-2:] == ["--runner", "docker"]
    assert env["ANTHROPIC_BASE_URL"] == "http://host.docker.internal:8765/rollout/abc"
    servers = json.loads(runtime.files[".vf-mst/t-1/eval.json"])["servers"]
    assert servers["tools"]["serverUrl"] == "http://host.docker.internal:9001/mcp"
    assert servers["remote"]["serverUrl"] == "https://mcp.example.com/mcp"


async def test_the_trials_artifacts_are_located_in_the_run() -> None:
    runtime = FakeRuntime(trial_file(artifacts="artifacts/default/rollout/1"))
    trace = fake_trace()
    await launch(harness(client="cowork"), runtime, trace)
    assert trace.info["mst"]["artifacts"] == "results/runs/r1/artifacts/default/rollout/1"


async def test_workdir_needs_a_client_with_a_cwd_option() -> None:
    with pytest.raises(ValueError, match="cwd"):
        await launch(
            harness(client="api", workdir=["answer"]), FakeRuntime(trial_file()), fake_trace()
        )


@pytest.mark.parametrize(
    ("config", "openai"),
    [
        ({"client": "codex-cli"}, True),
        ({"client": "api"}, False),
        ({"client": "claude-code"}, False),
    ],
)
async def test_the_client_picks_the_endpoint_variables(
    config: dict[str, str], openai: bool
) -> None:
    runtime = FakeRuntime(trial_file())
    await launch(harness(**config), runtime, fake_trace())
    env = runtime.mst_run()[1]
    if openai:
        assert (env["OPENAI_BASE_URL"], env["OPENAI_API_KEY"]) == (ENDPOINT, "secret-1")
        assert env["ANTHROPIC_BASE_URL"] == ""
    else:
        assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8765/rollout/abc"
        assert env["OPENAI_BASE_URL"] == ""


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


async def test_a_client_that_fails_before_any_model_call_fails_the_rollout() -> None:
    missing = "The codex client requires the `@openai/codex-sdk` package"
    trial = trial_file(error=missing, transcript={"finalText": "", "events": [], "modelCalls": []})
    result = await launch(harness(client="codex-cli"), FakeRuntime(trial), fake_trace(calls=[]))
    assert result.exit_code == 1
    assert "failed before any model call" in result.stderr
    assert missing in result.stderr


async def test_a_client_error_after_model_calls_is_scored() -> None:
    # MST's ADR 0010: an error after the model acted is the model's outcome, so it is graded.
    trial = trial_file(error="The client timed out")
    result = await launch(harness(), FakeRuntime(trial), fake_trace())
    assert result.exit_code == 0


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

    with pytest.raises(RuntimeError, match=r"npx mst.*mst_command"):
        await harness(mst_command=["npx", "mst"]).setup(cast(Runtime, Missing(None)))


def test_parse_trial_reads_an_rc0_trace() -> None:
    rc0 = json.loads(trial_file())
    rc0["trace"] = rc0.pop("transcript")
    result = parse_trial(json.dumps(rc0))
    assert result.final_text == "The answer."
    assert result.info()["transcript"]["events"][0]["name"] == "search"


class RejectsWrites(FakeRuntime):
    """An MST from before `writes` (2.0.0-rc.0): it rejects the key and runs nothing."""

    def __init__(self) -> None:
        super().__init__(trial_file())
        self.collected = False

    async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        if argv[:2] == ["mst", "run"]:
            config = json.loads(self.files[".vf-mst/t-1/eval.json"])
            if "writes" in config:
                self.runs.append((argv, env))
                return ProgramResult(1, "", 'Invalid configuration:\n✖ Unrecognized key: "writes"')
            self.collected = True
        if argv[0] == "sh" and "ls " in argv[2] and not self.collected:
            return ProgramResult(0, "", "")
        return await super().run(argv, env)


async def test_an_mst_that_rejects_writes_gets_the_trial_without_them() -> None:
    h = harness()
    runtime = RejectsWrites()
    result = await launch(h, runtime, fake_trace())
    assert result.exit_code == 0
    assert [argv[:2] for argv, _ in runtime.runs].count(["mst", "run"]) == 2
    assert "writes" not in json.loads(runtime.files[".vf-mst/t-1/eval.json"])
    # Later rollouts leave `writes` out from the start.
    runtime.runs.clear()
    await launch(h, runtime, fake_trace())
    assert [argv[:2] for argv, _ in runtime.runs].count(["mst", "run"]) == 1


async def test_writes_are_declared_to_an_mst_that_takes_them() -> None:
    runtime = FakeRuntime(trial_file())
    await launch(harness(), runtime, fake_trace())
    assert json.loads(runtime.files[".vf-mst/t-1/eval.json"])["writes"] == {"acme": "unguarded"}


def test_verifiers_loads_the_package_as_a_harness() -> None:
    assert harness_class("mst-harness") is MSTHarness
    assert harness_config_type("mst-harness") is MSTHarnessConfig


def test_the_harness_takes_mcp_servers_and_a_system_prompt() -> None:
    assert MSTHarness.SUPPORTS_MCP is True
    assert MSTHarness.APPENDS_SYSTEM_PROMPT is True


def test_host_urls_move_to_the_container_loopback() -> None:
    forwarding = cowork_container.forward_to_loopback(
        "http://host.docker.internal:8765/v1",
        {
            "tools": "http://127.0.0.1:9001/mcp",
            "remote": "https://mcp.example.com/mcp",
        },
    )
    assert forwarding.endpoint == "http://127.0.0.1:8765/v1"
    assert forwarding.mcp_urls == {
        "tools": "http://127.0.0.1:9001/mcp",
        "remote": "https://mcp.example.com/mcp",
    }
    assert forwarding.ports == (8765, 9001)


def test_a_host_url_without_a_port_is_rejected() -> None:
    with pytest.raises(ValueError, match="explicit port"):
        cowork_container.forward_to_loopback("http://host.docker.internal/v1", {})


def test_the_cowork_container_starts_as_mst_starts_it() -> None:
    args = cowork_container.docker_run_args(
        name="r1",
        image="mst-cowork-linux:2.0.0-rc.0",
        workdir="/home/mst/work",
        gateway=cowork_container.gateway_url("http://127.0.0.1:8765/v1"),
        model="claude-sonnet-4-6",
        seccomp="unconfined",
        memory=8,
    )
    for device in cowork_container.DEVICES:
        assert ["--device", device] == args[args.index(device) - 1 : args.index(device) + 1]
    assert "MST_INFERENCE_GATEWAY_URL=http://127.0.0.1:8765" in args
    assert "MST_INFERENCE_MODELS=claude-sonnet-4-6" in args
    assert args[args.index("--memory") : args.index("--memory") + 2] == ["--memory", "8g"]
    assert args[-1] == "mst-cowork-linux:2.0.0-rc.0"


def test_mst_runs_as_the_desktop_user_in_the_workdir() -> None:
    args = cowork_container.desktop_user_exec_args(
        "r1", "/home/mst/work", ["mst", "run"], {"A": "1"}
    )
    assert args == ["exec", "-u", "mst", "-w", "/home/mst/work", "--env", "A=1", "r1", "mst", "run"]


async def test_cowork_container_needs_a_docker_runtime_and_cowork() -> None:
    with pytest.raises(ValueError, match="Docker runtime"):
        await launch(
            harness(client="cowork", cowork_container=True), FakeRuntime(None), fake_trace()
        )

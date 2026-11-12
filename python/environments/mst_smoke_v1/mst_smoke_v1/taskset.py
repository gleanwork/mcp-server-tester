"""Tasks that need one MCP tool call, scored on the client's final reply.

Each row in `tasks.jsonl` names a project. The answer is the project's code, which only
the taskset's MCP server knows, so a correct reply shows the whole path worked: the
prompt reached the MST client, the client called the task's MCP server, and its final
reply came back through the harness.
"""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path
from typing import Any

import verifiers.v1 as vf

from mst_smoke_v1.servers.tool import MstSmokeToolset, code_for

TOOL_NAME = "lookup_code"


class MstSmokeData(vf.TaskData):
    project: str
    """The project whose code the reply must contain."""


class MstSmokeTaskConfig(vf.TaskConfig):
    tools: vf.ToolsetConfig = vf.ToolsetConfig()


class MstSmokeTask(vf.Task[MstSmokeData, vf.State, MstSmokeTaskConfig]):
    tools = (MstSmokeToolset,)

    @vf.reward(weight=1.0)
    async def correct_code(self, trace: vf.Trace) -> float:
        """1 when the final reply contains the project's code."""
        return float(code_for(self.data.project) in trace.last_reply)

    @vf.metric
    async def called_tool(self, trace: vf.Trace) -> float:
        """1 when MST's transcript shows the client called `lookup_code`."""
        return float(any(TOOL_NAME in name for name in _mst_tool_calls(trace)))


class MstSmokeConfig(vf.TasksetConfig):
    tasks_path: str | None = None
    """A JSONL file of tasks; the packaged `tasks.jsonl` when unset."""
    upstream_bearer: bool = False
    """Send the model key upstream as `Authorization: Bearer` too (some gateways need it)."""
    task: MstSmokeTaskConfig = MstSmokeTaskConfig()


class MstSmokeTaskset(vf.Taskset[MstSmokeTask, MstSmokeConfig]):
    def load(self) -> list[MstSmokeTask]:
        if self.config.tasks_path:
            text = Path(self.config.tasks_path).read_text()
        else:
            text = files("mst_smoke_v1").joinpath("tasks.jsonl").read_text()
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        return [
            MstSmokeTask(MstSmokeData(idx=idx, **row), self.config.task)
            for idx, row in enumerate(rows)
        ]


def _mst_tool_calls(trace: vf.Trace) -> list[str]:
    mst: Any = trace.info.get("mst") or {}
    events: Any = (mst.get("transcript") or {}).get("events") or []
    return [str(e.get("name", "")) for e in events if isinstance(e, dict)]

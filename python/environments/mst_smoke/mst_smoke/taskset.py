"""Tasks that need one MCP tool call, scored on the client's final reply.

The answer is a project's code, which only the task's `lookup_code` tool knows, so a
correct reply shows the whole path worked: the prompt reached the MST client, the
client called the task's MCP server, and its final reply reached the reward.
"""

import verifiers.v1 as vf

from mst_smoke.servers.tool import MstSmokeToolset, code_for

PROMPTS = {
    "aurora": (
        "What is the access code for the project named aurora? Look it up with the "
        "lookup_code tool and reply with the code."
    ),
    "borealis": (
        "Find the access code for project borealis using your tools, then tell me the code."
    ),
}


class MstSmokeTaskConfig(vf.TaskConfig):
    tools: vf.ToolsetConfig = vf.ToolsetConfig()


class MstSmokeData(vf.TaskData):
    project: str
    """The project whose code the reply must contain."""


class MstSmokeTask(vf.Task[MstSmokeData, vf.State, MstSmokeTaskConfig]):
    @classmethod
    def toolsets(cls, config: MstSmokeTaskConfig) -> list[vf.Toolset]:
        return [MstSmokeToolset(config.tools)]

    @vf.reward(weight=1.0)
    async def correct_code(self, trace: vf.Trace) -> float:
        return float(code_for(self.data.project) in (trace.last_reply or ""))


class MstSmokeConfig(vf.TasksetConfig):
    task: MstSmokeTaskConfig = MstSmokeTaskConfig()


class MstSmokeTaskset(vf.Taskset[MstSmokeTask, MstSmokeConfig]):
    def load(self) -> list[MstSmokeTask]:
        return [
            MstSmokeTask(
                MstSmokeData(name=project, prompt=prompt, project=project), self.config.task
            )
            for project, prompt in PROMPTS.items()
        ]

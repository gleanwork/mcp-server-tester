"""mst-smoke-v1 verifiers environment.

`uv run eval @ configs/eval.toml` imports this package because
`taskset.id = "mst-smoke-v1"`. The harness is MST's: `harness.id = "mst-harness"`.

Discovered from `__all__` by subclass:
  - MstSmokeTaskset — Taskset (tasks + MCP tool + reward)
  - MstSmokeEnvironment — Environment (optional Bearer upstream auth)
"""

from mst_smoke_v1.env import MstSmokeEnvironment
from mst_smoke_v1.taskset import MstSmokeTaskset

__all__ = ["MstSmokeEnvironment", "MstSmokeTaskset"]

"""mst-smoke-v1 verifiers environment.

`mst verifiers run python/environments/mst_smoke_v1 --model <model>` loads this package
as taskset `mst-smoke-v1`, with MST's harness (`mst-harness`).

Discovered from `__all__` by subclass:
  - MstSmokeTaskset — Taskset (tasks + MCP tool + reward)
  - MstSmokeEnvironment — Environment (optional Bearer upstream auth)
"""

from mst_smoke_v1.env import MstSmokeEnvironment
from mst_smoke_v1.taskset import MstSmokeTaskset

__all__ = ["MstSmokeEnvironment", "MstSmokeTaskset"]

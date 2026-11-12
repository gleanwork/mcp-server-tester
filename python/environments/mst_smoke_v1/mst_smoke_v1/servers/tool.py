"""The MCP tool the smoke tasks need: a lookup only the server can answer."""

from __future__ import annotations

import hashlib

import verifiers.v1 as vf


def code_for(name: str) -> str:
    """The code `lookup_code` returns for a name. Deterministic, and not guessable."""
    digest = hashlib.sha256(f"mst-smoke:{name.strip().lower()}".encode()).hexdigest()
    return f"MST-{digest[:6].upper()}"


class MstSmokeToolset(vf.Toolset[vf.ToolsetConfig]):
    TOOL_PREFIX = "mst_smoke"

    @vf.tool
    def lookup_code(self, name: str) -> str:
        """Return the access code registered for a project name."""
        return code_for(name)


if __name__ == "__main__":
    MstSmokeToolset.run()

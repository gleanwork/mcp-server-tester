"""The smoke environment: verifiers' interception, with an optional Bearer upstream.

verifiers' Anthropic dialect sends the upstream key as `x-api-key`. Some gateways want
`Authorization: Bearer` instead; `taskset.upstream_bearer = true` adds it, the way
enterprise-bench's interception server does for the Glean gateway.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from verifiers.v1.clients import EvalClient
from verifiers.v1.env import Environment
from verifiers.v1.interception import InterceptionServer
from verifiers.v1.interception.server import InterceptionServerConfig
from verifiers.v1.session import RolloutSession


class BearerInterceptionServer(InterceptionServer):
    def register(self, session: RolloutSession) -> str:
        client = session.ctx.client
        if isinstance(client, EvalClient):
            client.headers.setdefault("Authorization", f"Bearer {client.api_key}")
        return super().register(session)


class MstSmokeEnvironment(Environment):
    @asynccontextmanager
    async def serving(self) -> AsyncIterator[None]:
        if not getattr(self.config.taskset, "upstream_bearer", False):
            async with super().serving():
                yield
            return
        async with self.shared_tools() as shared:
            if not isinstance(self.config.interception, InterceptionServerConfig):
                raise TypeError("upstream_bearer requires interception.type = 'server'")
            interception = BearerInterceptionServer(
                self.config.interception, requires_tunnel=self._requires_tunnel(shared)
            )
            async with interception:
                self._shared_tools = shared
                self._interception = interception
                try:
                    yield
                finally:
                    self._shared_tools = {}
                    self._interception = None

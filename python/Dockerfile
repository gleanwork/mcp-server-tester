# syntax=docker/dockerfile:1
#
# A verifiers runtime image with MST installed, for mst-harness rollouts in a container:
#
#   docker build -t mst-verifiers-runtime python/
#   python -c 'from verifiers.v1.cli.eval.main import main; main()' <taskset> \
#     --harness.id mst-harness \
#     --harness.runtime.type docker --harness.runtime.image mst-verifiers-runtime
#
# MST comes from public npm by default. To install from a private registry, build with
# `--build-arg NPM_REGISTRY=<url>` and `--secret id=npmrc,src=$HOME/.npmrc`: the `npmrc`
# secret holds the registry's token and stays out of the image's layers.
#
# verifiers runs the taskset, its tool servers and the interception server on the host;
# the container only needs `mst` and the clients it starts.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# The MST version: a version or a dist-tag. 2.0 is published under `rc`.
ARG MST_VERSION=rc
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Client SDKs to install next to MST, for example `@openai/codex-sdk` for codex-cli or
# `@anthropic-ai/claude-agent-sdk` for claude-code. The `api` client needs none.
ARG CLIENT_PACKAGES=""

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm install --global --no-fund --no-audit --registry "${NPM_REGISTRY}" \
      "@gleanwork/mcp-server-tester@${MST_VERSION}" ${CLIENT_PACKAGES} \
    && npm cache clean --force \
    && mst --version

WORKDIR /app

# syntax=docker/dockerfile:1.7
# A disposable Linux ChatGPT desktop for `mst run --env docker`.
# The caller supplies a verified base and app package; no credential enters a layer.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE
FROM ${NODE_IMAGE} AS node_runtime

FROM ${BASE_IMAGE}

ARG APP_PACKAGE
ARG APP_VERSION
ARG APP_ARCHITECTURE
ARG APP_URL
ARG APP_SHA256
ARG APP_SIZE

ENV DISPLAY=:1 \
    SELKIES_MANUAL_WIDTH=1920 \
    SELKIES_MANUAL_HEIGHT=1080 \
    MST_PLUGIN_DIR=/opt/mst/plugins \
    MST_TOKENS_DIR=/run/mst/tokens \
    MST_JUDGE_SANDBOX=container \
    MST_CHATGPT_APP_VERSION=${APP_VERSION} \
    LANG=C.UTF-8

RUN test -n "$APP_PACKAGE" && test -n "$APP_VERSION" && test -n "$APP_URL" \
    && test -n "$APP_SHA256" && test -n "$APP_SIZE" \
    && test "$(dpkg --print-architecture)" = "$APP_ARCHITECTURE" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools \
        openbox x11-utils python3 python3-gi gir1.2-atspi-2.0 tini procps \
    && curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
        --max-time 600 --max-filesize "$APP_SIZE" "$APP_URL" --output /tmp/chatgpt.deb \
    && echo "$APP_SHA256  /tmp/chatgpt.deb" | sha256sum --check --strict \
    && test "$(stat -c %s /tmp/chatgpt.deb)" = "$APP_SIZE" \
    && test "$(dpkg-deb --field /tmp/chatgpt.deb Package)" = "$APP_PACKAGE" \
    && test "$(dpkg-deb --field /tmp/chatgpt.deb Version)" = "$APP_VERSION" \
    && test "$(dpkg-deb --field /tmp/chatgpt.deb Architecture)" = "$APP_ARCHITECTURE" \
    && printf 'repo_add_once="false"\n' > "/etc/default/$APP_PACKAGE" \
    && apt-get install -y --no-install-recommends /tmp/chatgpt.deb \
    && test "$(dpkg-query -W -f='${Version}' "$APP_PACKAGE")" = "$APP_VERSION" \
    && apt-mark hold "$APP_PACKAGE" \
    && rm /tmp/chatgpt.deb \
    && rm -rf /var/lib/apt/lists/*

# Node and npm from a matching Debian stage; the desktop base supplies X/AT-SPI.
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version

COPY mst-package/ /tmp/mst-package/
RUN set -e; \
    if ls /tmp/mst-package/*.tgz >/dev/null 2>&1; then \
      npm install -g /tmp/mst-package/*.tgz; \
    else \
      echo 'MST package missing from image build context' >&2; exit 1; \
    fi; \
    rm -rf /tmp/mst-package /root/.npm; \
    mst --version

COPY plugins/ /tmp/mst-plugins/
RUN set -e; \
    install -d -m 0755 /opt/mst/plugins; \
    if ls /tmp/mst-plugins/*.tgz >/dev/null 2>&1; then \
      cd /opt/mst/plugins; \
      echo '{"private":true}' > package.json; \
      npm install --omit=dev --legacy-peer-deps --no-audit --no-fund /tmp/mst-plugins/*.tgz; \
      rm -rf node_modules/@gleanwork/mcp-server-tester; \
      install -d node_modules/@gleanwork; \
      ln -s "$(npm root -g)/@gleanwork/mcp-server-tester" node_modules/@gleanwork/mcp-server-tester; \
    fi; \
    rm -rf /tmp/mst-plugins /root/.npm

COPY --chmod=755 bin/ /opt/mst/bin/

ENV HOME=/config

LABEL org.opencontainers.image.title="MST ChatGPT Linux desktop" \
      org.opencontainers.image.source="https://github.com/gleanwork/mcp-server-tester"

# Keep the base image's /init. It starts the X display; MST's worker wrapper
# creates a fresh private D-Bus, keyring and profile for every shard.

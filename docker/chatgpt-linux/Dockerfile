# syntax=docker/dockerfile:1.7
#
# A Linux desktop that runs the ChatGPT desktop app for `mst run --env docker`.
# Build it with `mst env setup docker --config <a chatgpt eval>`, which passes
# MST's own package so the worker runs the same MST as the run. See
# docs/chatgpt-docker.md.
#
# Nothing secret is baked in: the inference token or API key arrives at run
# time in /run/mst (a tmpfs), and the app's profile starts empty.
ARG NODE_IMAGE=node:22-trixie-slim
FROM ${NODE_IMAGE}

# Empty: the newest version in OpenAI's repository.
ARG CHATGPT_VERSION=
ARG MST_PACKAGE=@gleanwork/mcp-server-tester
ARG CHATGPT_REPOSITORY=https://persistent.oaistatic.com/codex-app-prod/linux/deb

ENV DEBIAN_FRONTEND=noninteractive

# The desktop session, AT-SPI and xdotool for MST's driver, and a keyring: without an
# unlocked one the app waits on a password prompt before it shows a window.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl tini procps \
    xvfb x11-utils x11-apps xdotool dbus dbus-x11 at-spi2-core libglib2.0-bin \
    python3 python3-gi gir1.2-atspi-2.0 \
    gnome-keyring libsecret-1-0 fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# The app, from OpenAI's apt repository: the package the repository's index
# lists for this architecture, checked against the index's SHA-256 and size.
# The repository isn't added to apt, so nothing updates the app afterwards.
COPY --chmod=755 bin/chatgpt-package /opt/mst/bin/chatgpt-package
RUN set -e; \
  /opt/mst/bin/chatgpt-package "${CHATGPT_REPOSITORY}" "${CHATGPT_VERSION}" /tmp/chatgpt.deb; \
  printf 'repo_add_once="false"\n' > /etc/default/chatgpt; \
  apt-get update; \
  apt-get install -y --no-install-recommends /tmp/chatgpt.deb; \
  rm -f /tmp/chatgpt.deb /etc/apt/sources.list.d/chatgpt*; \
  rm -rf /var/lib/apt/lists/*; \
  test -x /usr/bin/chatgpt; \
  test -x /usr/lib/chatgpt/resources/codex; \
  dpkg-query -W -f='ChatGPT ${Version}\n' chatgpt

# MST itself: the published package, or the tarball `mst env setup docker`
# packs from a source checkout (in ./mst-package).
COPY mst-package/ /tmp/mst-package/
RUN set -e; \
  if ls /tmp/mst-package/*.tgz >/dev/null 2>&1; then \
    npm install -g /tmp/mst-package/*.tgz; \
  else \
    npm install -g "${MST_PACKAGE}"; \
  fi; \
  rm -rf /tmp/mst-package /root/.npm; \
  mst --version

# The desktop user, uid 1000 (the node image's `node` user, renamed).
RUN usermod -l mst -d /home/mst -m node && groupmod -n mst node

COPY --chmod=755 bin/ /opt/mst/bin/

# The eval's plugin packages (`mst env setup docker --config`), packed from
# the machine that runs MST, with their dependencies. A plugin's own
# @gleanwork/mcp-server-tester is the MST above, so both share one instance.
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

# What `docker exec` inherits: the Linux ChatGPT client's environment
# contract (docs/chatgpt-desktop.md). HOME is a fresh private directory on the
# tmpfs; the client creates and removes $HOME/.codex for each session. How the
# app gets inference (a gateway URL, or an API key) is set by `mst run`.
ENV DISPLAY=:99 \
  XDG_RUNTIME_DIR=/run/mst/session \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/mst/session/bus \
  AT_SPI_BUS_ADDRESS=unix:path=/run/mst/session/at-spi/bus_99 \
  GNOME_KEYRING_CONTROL=/run/mst/session/keyring \
  HOME=/run/mst/home \
  XDG_CONFIG_HOME=/run/mst/home/.config \
  XDG_DATA_HOME=/run/mst/home/.local/share \
  XDG_CACHE_HOME=/run/mst/home/.cache \
  TMPDIR=/run/mst/tmp \
  MST_CHATGPT_APP_PATH=/usr/bin/chatgpt \
  MST_CHATGPT_CODEX_PATH=/usr/lib/chatgpt/resources/codex \
  MST_CHATGPT_PYTHON=/usr/bin/python3 \
  MST_CHATGPT_EVIDENCE_DIR=/run/mst/evidence \
  MST_TOKENS_DIR=/run/mst/tokens \
  MST_PLUGIN_DIR=/opt/mst/plugins \
  LANG=C.UTF-8

LABEL org.opencontainers.image.title="MST ChatGPT Linux desktop" \
  org.opencontainers.image.source="https://github.com/gleanwork/mcp-server-tester"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/mst/bin/desktop-session"]

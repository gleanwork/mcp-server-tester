# syntax=docker/dockerfile:1.7
#
# A Linux desktop that runs Claude Desktop's Cowork for `mst run --env docker`.
# Build it with `mst env setup docker`, which passes MST's own package so the
# worker runs the same MST as the run. See docs/cowork-docker.md.
#
# Nothing secret is baked in: the inference token arrives at run time in
# /run/mst (a tmpfs), and Claude Desktop's profile starts empty.
ARG NODE_IMAGE=node:22-trixie-slim
FROM ${NODE_IMAGE}

ARG CLAUDE_DESKTOP_VERSION=
ARG MST_PACKAGE=@gleanwork/mcp-server-tester

ENV DEBIAN_FRONTEND=noninteractive

# The desktop session, AT-SPI for MST's driver, and the VM Cowork runs its
# agent in (QEMU, UEFI firmware and virtiofsd for the host's architecture).
RUN arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
    amd64) vm_packages="qemu-system-x86 ovmf" ;; \
    arm64) vm_packages="qemu-system-arm qemu-efi-aarch64" ;; \
    *) echo "Cowork needs amd64 or arm64, not ${arch}" >&2; exit 1 ;; \
  esac \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg tini procps sudo \
    xvfb x11-utils x11-apps dbus dbus-x11 at-spi2-core libglib2.0-bin \
    python3 python3-gi gir1.2-atspi-2.0 xclip \
    fonts-dejavu-core virtiofsd ipxe-qemu ${vm_packages} \
  && curl -fsSLo /usr/share/keyrings/claude-desktop.asc \
    https://downloads.claude.ai/claude-desktop/key.asc \
  && echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" \
    > /etc/apt/sources.list.d/claude-desktop.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    "claude-desktop${CLAUDE_DESKTOP_VERSION:+=${CLAUDE_DESKTOP_VERSION}}" \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/bin/claude-desktop

# Cowork's VM bundle, which Claude Desktop would otherwise download (1.2 GB)
# in every new container. MST_SEED_VM_BUNDLE=0 skips it.
ARG MST_SEED_VM_BUNDLE=1
COPY --chmod=755 bin/vm-bundle-manifest.mjs bin/seed-vm-bundle /opt/mst/bin/
RUN if [ "${MST_SEED_VM_BUNDLE}" = 1 ]; then /opt/mst/bin/seed-vm-bundle; fi

# virtiofsd's seccomp filter needs syscalls a container's default profile
# denies; the container's own profile still applies.
RUN real="$(command -v virtiofsd || echo /usr/libexec/virtiofsd)" \
  && mv "${real}" "${real}.real" \
  && printf '#!/bin/sh\nexec %s.real --seccomp none "$@"\n' "${real}" > "${real}" \
  && chmod 755 "${real}"

# MST itself: the tarball `mst env setup docker` packs from the coordinator's
# MST, a checkout or an installed package (in ./mst-package), so the worker
# runs the coordinator's MST; else the published package.
COPY mst-package/ /tmp/mst-package/
RUN set -e; \
  if ls /tmp/mst-package/*.tgz >/dev/null 2>&1; then \
    npm install -g /tmp/mst-package/*.tgz; \
  else \
    npm install -g "${MST_PACKAGE}"; \
  fi; \
  rm -rf /tmp/mst-package /root/.npm; \
  mst --version

# The desktop user, uid 1000 (the node image's `node` user, renamed). Its
# only sudo rule installs the settings it staged (see bin/install-settings).
RUN usermod -l mst -d /home/mst -m node && groupmod -n mst node \
  && install -d -m 0755 /etc/claude-desktop \
  && echo 'mst ALL=(root) NOPASSWD: /opt/mst/bin/install-settings' \
    > /etc/sudoers.d/mst-settings \
  && chmod 0440 /etc/sudoers.d/mst-settings

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

# What `docker exec` inherits: the session MST's Linux driver attaches to,
# and owned-desktop mode (MST writes each variant's settings and restarts
# Claude Desktop with MST_DESKTOP_RESTART). MST_JUDGE_SANDBOX: a grade
# shard's Codex judge can't start its own sandbox here; the container is it.
ENV DISPLAY=:99 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/mst/session/bus \
  XDG_RUNTIME_DIR=/run/mst/session \
  MST_DESKTOP_OWNED=1 \
  MST_DESKTOP_RESTART=/opt/mst/bin/restart-desktop \
  MST_DESKTOP_RESTART_TIMEOUT_S=900 \
  MST_COWORK_SETTINGS_FILE=/run/mst/settings/managed-settings.json \
  MST_COWORK_HELPER_DIR=/home/mst/.mst/cowork-helpers \
  MST_COWORK_URL_OPENER=/opt/mst/bin/open-url \
  MST_COWORK_PYTHON=/usr/bin/python3 \
  MST_TOKENS_DIR=/run/mst/tokens \
  MST_PLUGIN_DIR=/opt/mst/plugins \
  MST_JUDGE_SANDBOX=container \
  LANG=C.UTF-8

LABEL org.opencontainers.image.title="MST Cowork Linux desktop" \
  org.opencontainers.image.source="https://github.com/gleanwork/mcp-server-tester"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/mst/bin/desktop-session"]

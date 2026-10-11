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
    python3 python3-gi gir1.2-atspi-2.0 \
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

# virtiofsd's seccomp filter needs syscalls a container's default profile
# denies; the container's own profile still applies.
RUN real="$(command -v virtiofsd || echo /usr/libexec/virtiofsd)" \
  && mv "${real}" "${real}.real" \
  && printf '#!/bin/sh\nexec %s.real --seccomp none "$@"\n' "${real}" > "${real}" \
  && chmod 755 "${real}"

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

# The desktop user, uid 1000 (the node image's `node` user, renamed). Its
# only sudo rule installs the settings it staged (see bin/install-settings).
RUN usermod -l mst -d /home/mst -m node && groupmod -n mst node \
  && install -d -m 0755 /etc/claude-desktop \
  && echo 'mst ALL=(root) NOPASSWD: /opt/mst/bin/install-settings' \
    > /etc/sudoers.d/mst-settings \
  && chmod 0440 /etc/sudoers.d/mst-settings

COPY --chmod=755 bin/ /opt/mst/bin/

# What `docker exec` inherits: the session MST's Linux driver attaches to,
# and owned-desktop mode (MST writes each variant's settings and restarts
# Claude Desktop with MST_DESKTOP_RESTART).
ENV DISPLAY=:99 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/mst/session/bus \
  XDG_RUNTIME_DIR=/run/mst/session \
  MST_DESKTOP_OWNED=1 \
  MST_DESKTOP_RESTART=/opt/mst/bin/restart-desktop \
  MST_DESKTOP_RESTART_TIMEOUT_S=900 \
  MST_COWORK_SETTINGS_FILE=/run/mst/settings/managed-settings.json \
  MST_COWORK_URL_OPENER=/opt/mst/bin/open-url \
  MST_COWORK_PYTHON=/usr/bin/python3 \
  MST_TOKENS_DIR=/run/mst/tokens \
  LANG=C.UTF-8

LABEL org.opencontainers.image.title="MST Cowork Linux desktop" \
  org.opencontainers.image.source="https://github.com/gleanwork/mcp-server-tester"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/mst/bin/desktop-session"]

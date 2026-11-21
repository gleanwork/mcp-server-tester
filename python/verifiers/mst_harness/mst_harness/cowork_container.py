"""Run Cowork in the rollout's Docker runtime, in MST's Linux desktop image.

Claude Desktop takes an inference gateway only over https or loopback http, and
verifiers serves its endpoint and tool servers over http on the host. So the harness
replaces the runtime's container with one MST's Cowork Linux image can run in, as
MST's own Docker runner starts it (`dockerRunArgs` in src/evals/runners/docker.ts):

1. The container gets Cowork's VM devices (KVM, vsock, net), a `/run/mst` tmpfs, and
   a gateway URL on its own loopback. The image's entrypoint writes Claude Desktop's
   base settings from it and starts the desktop.
2. A forwarder in the container passes each loopback port the endpoint and the MCP
   servers use to the host, where verifiers serves them.
3. The rollout's secret goes to `/run/mst/inference-token`, which the image's
   credential helper reads when Claude Desktop asks.
4. Once the desktop says it's ready, `mst run` runs in the container as the desktop
   user, and drives that desktop (MST's owned-desktop mode: it writes the variant's
   MCP servers into the settings and restarts the desktop).

The container keeps the runtime's name, so the runtime's own cleanup removes it.
"""

from __future__ import annotations

import asyncio
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from verifiers.v1.runtimes import DockerRuntime, ProgramResult

# Inside the image (docker/cowork-linux/Dockerfile).
USER = "mst"
TOKEN_FILE = "/run/mst/inference-token"
SESSION_DIR = "/run/mst/session"
SETTINGS_DIR = "/run/mst/settings"
DEVICES = ("/dev/kvm", "/dev/vhost-vsock", "/dev/vhost-net", "/dev/net/tun")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# Hosts verifiers puts in a Docker runtime's URLs for the host's loopback.
HOST_ALIASES = frozenset({"host.docker.internal"})

# Listens on the container's loopback, one port per argument, and passes each
# connection to the same port on the host named first. Node is in the image.
FORWARDER = """
const net = require('net');
const [host, ...ports] = process.argv.slice(1);
for (const port of ports) {
  net.createServer((client) => {
    const upstream = net.connect(Number(port), host);
    const close = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  }).listen(Number(port), '127.0.0.1');
}
"""
PROBE = """
const net = require('net');
Promise.all(process.argv.slice(1).map((port) => new Promise((ok, fail) => {
  const socket = net.connect(Number(port), '127.0.0.1', () => { socket.end(); ok(); });
  socket.on('error', fail);
}))).then(() => process.exit(0), () => process.exit(1));
"""


@dataclass(frozen=True)
class Forwarding:
    """The URLs the container's clients use, and the host ports behind them."""

    endpoint: str
    mcp_urls: dict[str, str]
    ports: tuple[int, ...]


def forward_to_loopback(
    endpoint: str, mcp_urls: Mapping[str, str], host_alias: str | None = None
) -> Forwarding:
    """The endpoint and MCP URLs on the container's loopback, with the ports to forward.

    A URL on the host (a loopback host, `host.docker.internal`, or `host_alias`) keeps
    its port and moves to 127.0.0.1. Other URLs are passed unchanged.
    """
    hosts = LOOPBACK_HOSTS | HOST_ALIASES | ({host_alias} if host_alias else set())
    ports: set[int] = set()

    def local(url: str) -> str:
        parts = urlsplit(url)
        if parts.hostname not in hosts:
            return url
        if parts.port is None:
            raise ValueError(f"A URL on the host needs an explicit port: {url}")
        ports.add(parts.port)
        return urlunsplit(parts._replace(netloc=f"127.0.0.1:{parts.port}"))

    local_endpoint = local(endpoint)
    local_mcp = {name: local(url) for name, url in mcp_urls.items()}
    return Forwarding(local_endpoint, local_mcp, tuple(sorted(ports)))


def gateway_url(endpoint: str) -> str:
    """Claude Desktop's gateway base URL: the API root, as it appends `/v1/messages`."""
    return endpoint.rstrip("/").removesuffix("/v1")


def docker_run_args(
    *,
    name: str,
    image: str,
    workdir: str,
    gateway: str,
    model: str,
    seccomp: str,
    cpu: float | None = None,
    memory: float | None = None,
) -> list[str]:
    """`docker run` arguments for the rollout's Cowork container, as MST starts one."""
    limits: list[str] = []
    if cpu is not None:
        limits += ["--cpus", str(cpu)]
    if memory is not None:
        limits += ["--memory", f"{memory}g"]
    return [
        "run",
        "--detach",
        # Anonymous volumes go with the container when the runtime removes it.
        "--rm",
        "--name",
        name,
        # Cowork's VM: KVM, its vsock and network devices, and the vsock socket
        # family Docker's default seccomp profile denies. Nothing privileged.
        *(arg for device in DEVICES for arg in ("--device", device)),
        "--security-opt",
        f"seccomp={seccomp}",
        # The session, the settings and the inference token: memory only.
        "--tmpfs",
        "/run/mst:mode=0755",
        "--shm-size",
        "1g",
        "--env",
        f"MST_INFERENCE_GATEWAY_URL={gateway}",
        "--env",
        "MST_INFERENCE_AUTH_SCHEME=bearer",
        "--env",
        f"MST_INFERENCE_MODELS={model}",
        *limits,
        "--workdir",
        workdir,
        image,
    ]


def desktop_user_exec_args(
    name: str, workdir: str, argv: Sequence[str], env: Mapping[str, str]
) -> list[str]:
    """`docker exec` arguments that run `argv` as the image's desktop user.

    As MST's Docker runner runs its worker (`containerChannel`): `-u mst` in the work
    directory, so the process gets the image's environment for that user. MST
    restarts Claude Desktop with the image's `restart-desktop`, which only the desktop
    user can do, and a root `docker exec` dropped to it with `setpriv` can't start
    Cowork's warm-up task.
    """
    env_args = [arg for key, value in env.items() for arg in ("--env", f"{key}={value}")]
    return ["exec", "-u", USER, "-w", workdir, *env_args, name, *argv]


async def run_as_desktop_user(
    runtime: DockerRuntime, argv: Sequence[str], env: Mapping[str, str]
) -> ProgramResult:
    """Run `argv` in the runtime's container as the desktop user (see above)."""
    return await docker(*desktop_user_exec_args(runtime.name, runtime.config.workdir, argv, env))


async def docker(*args: str, stdin: bytes | None = None) -> ProgramResult:
    process = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(stdin)
    return ProgramResult(
        process.returncode or 0,
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
    )


async def _checked(what: str, *args: str, stdin: bytes | None = None) -> ProgramResult:
    result = await docker(*args, stdin=stdin)
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise RuntimeError(f"{what} failed: {detail or f'exit {result.exit_code}'}")
    return result


async def start_cowork_container(
    runtime: DockerRuntime,
    *,
    forwarding: Forwarding,
    secret: str,
    model: str,
    host: str,
    seccomp: str,
    ready_timeout_s: float,
) -> None:
    """Replace the runtime's container with a ready Cowork desktop (module docstring)."""
    name = runtime.name
    config = runtime.config
    await docker("rm", "--force", name)
    args = docker_run_args(
        name=name,
        image=config.image,
        workdir=config.workdir,
        gateway=gateway_url(forwarding.endpoint),
        model=model,
        seccomp=seccomp,
        cpu=config.cpu,
        memory=config.memory,
    )
    started = await _checked(f"Starting the Cowork container {name}", *args)
    runtime.info.id = started.stdout.strip()[:12]

    if forwarding.ports:
        ports = [str(port) for port in forwarding.ports]
        await _checked(
            "Starting the loopback forwarder",
            "exec",
            "--detach",
            name,
            "node",
            "-e",
            FORWARDER,
            host,
            *ports,
        )
        await _until(
            lambda: docker("exec", name, "node", "-e", PROBE, *ports),
            timeout_s=10,
            what=f"The loopback forwarder for ports {', '.join(ports)}",
        )

    # The entrypoint makes /run/mst's directories for the desktop user first.
    await _until(
        lambda: docker("exec", name, "sh", "-c", f'[ "$(stat -c %U {SETTINGS_DIR})" = {USER} ]'),
        timeout_s=60,
        what="The container's /run/mst directories",
    )
    await _checked(
        "Delivering the inference token",
        "exec",
        "-i",
        "-u",
        USER,
        name,
        "sh",
        "-c",
        f"umask 077 && cat > {TOKEN_FILE}.new && mv -f {TOKEN_FILE}.new {TOKEN_FILE}",
        stdin=secret.encode(),
    )
    await wait_for_desktop(name, ready_timeout_s)


async def wait_for_desktop(name: str, timeout_s: float) -> None:
    """Waits for the image's desktop session to say it's ready, or failed."""
    deadline = time.monotonic() + timeout_s
    check = (
        f"if [ -e {SESSION_DIR}/ready ]; then echo ready; "
        f"elif [ -e {SESSION_DIR}/failed ]; then echo failed; else echo starting; fi"
    )
    while time.monotonic() < deadline:
        state = await docker("exec", name, "sh", "-c", check)
        status = state.stdout.strip()
        if status == "ready":
            return
        if status == "failed" or state.exit_code != 0:
            log = await docker("exec", name, "tail", "-n", "5", f"{SESSION_DIR}/restart.log")
            why = (log.stdout or state.stderr or log.stderr).strip()
            raise RuntimeError(f"The desktop in container {name} didn't come up: {why}")
        await asyncio.sleep(3)
    raise RuntimeError(f"The desktop in container {name} wasn't ready within {timeout_s:g} s.")


async def give_to_desktop_user(runtime: DockerRuntime, path: str) -> None:
    """Make `path` (written by `runtime.write`, as root) the desktop user's."""
    await _checked(
        f"Handing {path} to the desktop user",
        "exec",
        "--workdir",
        runtime.config.workdir,
        runtime.name,
        "sh",
        "-c",
        f"mkdir -p {shlex.quote(path)} && chown -R {USER}:{USER} {shlex.quote(path)}",
    )


async def _until(
    probe: Callable[[], Awaitable[ProgramResult]], *, timeout_s: float, what: str
) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        result = await probe()
        if result.exit_code == 0:
            return
        if time.monotonic() >= deadline:
            detail = (result.stderr or result.stdout).strip()[-500:]
            raise RuntimeError(f"{what} wasn't ready within {timeout_s:g} s: {detail}")
        await asyncio.sleep(0.2)

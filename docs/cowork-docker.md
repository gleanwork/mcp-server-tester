# Cowork in Docker

`mst run --env docker` runs Cowork evals in Linux containers instead of on your own desktop. Each shard gets a container with its own Claude Desktop, and Cowork's VM runs inside it. Your machine stays usable while the eval runs.

MST provides the image as a Dockerfile that you build yourself (`mst env setup docker`). It installs Claude Desktop from Anthropic's Linux package repository at build time; MST doesn't publish an image with Claude Desktop in it.

## What you need

- A Docker host with KVM, and `/dev/vhost-vsock`, `/dev/vhost-net` and `/dev/net/tun`. Cowork runs its agent in a VM, so the container needs hardware virtualization:
  - **Linux:** a machine (or VM with nested virtualization) where `/dev/kvm` exists.
  - **Mac with Apple Silicon (M3 or later, macOS 15 or later):** a [Colima](https://github.com/abiosoft/colima) VM with nested virtualization.

    ```bash
    colima start mst-kvm --vm-type vz --nested-virtualization --cpu 6 --memory 12 --disk 40
    ```

- Inference for Cowork: MST's [LLM gateway settings](./llm-gateways.md), `ANTHROPIC_BASE_URL` with `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`.

## Build the image

```bash
npx mst env setup docker --env-option contexts=colima-mst-kvm
```

This builds `mst-cowork-linux:<MST version>` on each Docker context you name (default: the current one). The image installs the same MST version you run, because a worker must run the same MST as `mst run`. From a source checkout, it packs and installs the checkout. Pin Claude Desktop with `--env-option claudeDesktopVersion=<version>`. Rebuild after upgrading MST.

If the eval loads plugins, add `--config eval.json`: the image then installs them (see [Plugins](#plugins)).

The build also downloads Cowork's VM bundle (1.2 GB), which Claude Desktop would otherwise download in every new container. It reads the bundle's files and SHA-256 checksums from the Claude Desktop package, downloads them from the same place Claude Desktop does, and checks them. If the package's manifest can't be read, the build goes on without the bundle and Claude Desktop downloads it on first use.

## Run

```bash
npx mst run --config eval.json --env docker --env-option contexts=colima-mst-kvm
```

The eval config needs nothing Docker-specific. A Cowork eval uses `clientOptions.computerUseProvider: "linux-desktop"`. Set `coworkSetup.approveWriteTools: true` unless every server's tools need no approval: no one is there to click **Allow**.

Options (`--env-option key=value`):

| Option                 | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `shards`               | How many containers. A case's variants and trials all run in one.                                          |
| `contexts`             | Docker contexts, comma-separated. Each runs one container at a time (see below). Default: the current one. |
| `image`                | Another image, such as one your organization builds. Default: `mst-cowork-linux:<MST version>`.            |
| `readyTimeout`         | Seconds a new container's desktop has to come up. Default: 1200.                                           |
| `keep`                 | `never` (default), `failed` or `always`: keep containers to look at afterwards.                            |
| `claudeDesktopVersion` | `mst env setup` only: the Claude Desktop package to install.                                               |

**One container per Docker host at a time.** Claude Desktop's VM service listens on a fixed vsock port for the whole host, and containers don't separate vsock. So two Cowork containers can't run on one Docker host. To run shards side by side, give each its own host: several Colima VMs on a Mac, or remote Docker hosts, listed in `contexts`. With more shards than contexts, the extra shards wait for a free context.

## Plugins

Each container's worker loads the eval's plugins, so the image must have them. `mst env setup docker --config eval.json` installs each plugin the eval config names in the image, at `/opt/mst/plugins`:

- **A plugin must be a package:** a directory with a `package.json`, installed where the eval config finds it (`node_modules` beside it). A plugin named by a file path can't be installed, and setup says so.
- **Packed here, not downloaded:** setup runs `npm pack` on each plugin as this machine has it installed, so a private or linked package needs no registry access. The image build then installs each package's dependencies from the npm registry.
- **The image's MST:** a plugin's own `@gleanwork/mcp-server-tester` is the one the image runs.
- **Same version, or no run:** a run sends each plugin package's version to its workers, and a worker whose image has another version stops with "This worker has plugin …; the run uses …". After you change or upgrade a plugin, run `mst env setup docker --config eval.json` again.

The image holds one set of plugins: setting it up for another eval replaces them.

## What happens

For each shard, MST:

1. Starts a container with the VM devices, MST's seccomp profile, and a tmpfs at `/run/mst`. It isn't privileged.
2. Writes the inference token into the tmpfs, over `docker exec`'s stdin, and refreshes it every 4 minutes. The token is never in the image, on a command line, or on disk.
3. Waits for the desktop: Claude Desktop starts in gateway mode (no Claude.ai account), and the image clicks through the one first-run screen. This takes a few seconds; Cowork's VM isn't started yet.
4. Copies the shard's bundle in, and runs `mst collect` as the desktop user. For each variant, MST writes its servers and model into Claude Desktop's managed settings and restarts it ([owned-desktop mode](./cowork.md#attach-to-a-prepared-linux-desktop)). The restart boots Cowork's VM, and returns once the VM is ready.
5. Copies results and each trial's Cowork session folder back as trials finish, then removes the container.

## Each variant costs a VM boot

Claude Desktop reads its managed settings, and lists each MCP server's tools, only when it starts. It keeps the tool list for its whole run: a server's `notifications/tools/list_changed` doesn't refresh it. So each variant on a shard is a restart, and a restart stops Cowork's VM and boots a new one. A shard runs all of one variant's cases before the next variant's, so it restarts once per variant. A variant's datasets share that restart: MST skips a restart when the settings are the ones the desktop already runs with. Variants with tool metadata are the exception: their servers are a proxy with a URL of its own for each batch, so each of their datasets restarts too.

On a Mac, under nested virtualization, a boot takes about 2 minutes: the guest takes 1.5 to 2.5 minutes to start, while Claude Desktop gives it 60 seconds and fails that task. After each restart, the image starts one-line warm-up tasks ("Reply with OK.") until the VM is up, so a case finds it running. You'll see those tasks in the container's Cowork history. Measured on an M5 Pro: a fresh container to a finished one-case run took 2 min 39 s. A Linux host with KVM, without nesting, should boot the VM much faster; that hasn't been measured yet.

## When something fails

Keep the container and look inside:

```bash
npx mst run --config eval.json --env docker --env-option keep=failed
docker exec -it -u mst <container> bash
```

- `/run/mst/session/`: the session's logs (`claude.log`, `restart.log`), and `ready` or `failed`
- `~/.config/Claude-3p/logs/`: Claude Desktop's logs. `main.log` says whether it took the managed settings, and `cowork_vm_node.log` covers the VM
- `/etc/claude-desktop/managed-settings.json`: the settings Claude Desktop reads

The image is in `docker/cowork-linux/` of the package. Its `seccomp.json` is Docker's default profile ([moby/profiles](https://github.com/moby/profiles), Apache-2.0) with one rule added: sockets of the `AF_VSOCK` family, which Claude Desktop uses to reach Cowork's VM.

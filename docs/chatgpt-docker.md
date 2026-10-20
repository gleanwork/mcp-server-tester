# ChatGPT Work and Codex in Docker

`mst run --env docker --env-option desktop=chatgpt` collects cases in a
disposable Linux ChatGPT desktop. The eval config still uses `client: chatgpt`;
`clientOptions.surface` selects `chatgpt-work` or `codex`. Each shard has its
own container and fresh profile. Cowork remains the Docker environment's
default desktop.

## Build the image

MST builds an image from a caller-verified Linux base and ChatGPT package. Use
an immutable base-image digest, the official package URL, its SHA-256 and byte
size. These are build inputs, not credentials. The image installs the package,
the coordinator's exact MST version, and the eval's plugins. Rebuild after
changing MST, a plugin, or the ChatGPT app package.

```bash
npx mst env setup docker --config eval.json \
  --env-option desktop=chatgpt \
  --env-option chatgptBaseImage=ghcr.io/linuxserver/baseimage-selkies@sha256:<digest> \
  --env-option chatgptAppPackage=chatgpt \
  --env-option chatgptAppVersion=<version> \
  --env-option chatgptAppArchitecture=amd64 \
  --env-option chatgptAppUrl=https://<official-package-url>.deb \
  --env-option chatgptAppSha256=<64-hex-digit-sha256> \
  --env-option chatgptAppSize=<bytes>
```

The Docker host must be `linux/amd64` for an amd64 app package. Unlike
Cowork's Linux image, ChatGPT needs no nested virtualization or KVM devices.
Use `--env-option contexts=<docker-context>` on both setup and run when the
Docker daemon is remote. MST builds the default tag
`mst-chatgpt-linux:<MST version>`; `--env-option image=<tag>` overrides it.

## Collect and inspect

The Linux app signs in with `OPENAI_API_KEY`. Export it in the coordinator's
environment or put it in a private secrets file and pass `--secrets-file`.
MST sends it to each shard through its token channel, then stages it in a
private tmpfs file. It does not put the key in an image, Docker argument, or
container environment. The ChatGPT native client uses no Anthropic Computer
Use planner on Linux.

```bash
npx mst run --config eval.json --env docker \
  --env-option desktop=chatgpt --case <case-id> \
  --secrets-file .env
npx mst open --print
```

The file must contain `OPENAI_API_KEY=<key>`; MST does not read `.env`
implicitly. The default grader runs on the coordinator after collection.
Use `--no-grade` to collect first, then `mst grade <run-dir> --config eval.json`
on a machine with judge credentials. The native ChatGPT client and the
grader have separate credentials.

The image's `/init` brings up the display. MST waits for it, then the worker
creates a private D-Bus session, unlocked keyring, fresh HOME, and API-key
file for the shard. It runs `mst collect` once and removes the session when
that command ends. The container is removed when the shard ends unless the
run uses `--env-option keep=failed` or `keep=always`.

The Linux runtime checks and case evidence are described in
[ChatGPT desktop evaluation](chatgpt-desktop.md#linux-runtime-contract).

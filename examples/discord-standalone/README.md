# Discord standalone container

This image runs the existing Discord ingress and agent core through `naia-agent serve`. It runs as the unprivileged `node` user, exposes `/workspace` for the ADK workspace and `/var/lib/naia-agent` for runtime state, and does not start the Shell gRPC listener.

## Build

The agent package uses local `naia-memory` and `naia-kb-compiler` packages. Build their `dist/` outputs first, then build this image from the agent repository root with those repositories supplied as named build contexts:

```sh
cd naia-agent
podman build \
  --ignorefile examples/discord-standalone/.dockerignore \
  --build-context naia-memory=../naia-memory \
  --build-context naia-kb-compiler=../naia-kb-compiler \
  -f examples/discord-standalone/Dockerfile \
  -t naia-agent-discord .
```

Adjust the two context paths to the locations of those checkouts. The build copies only their package metadata and compiled output into the image.

Check the command entry point without starting the Gateway:

```sh
podman run --rm naia-agent-discord serve --help
```

## Configure state and authority

Mount an ADK workspace at `/workspace`. It should contain the usual `naia-settings/` provider and model configuration. The container writes status, dedupe, and other runtime state under `/var/lib/naia-agent`.

Create the state directory and generation authority file before starting the container. The generation value must match `NAIA_DISCORD_GENERATION`:

```sh
mkdir -p ./runtime-state ./workspace
chmod 700 ./runtime-state
printf '%s\n' '{"version":1,"generation":"generation_1"}' > ./runtime-state/authority.json
chmod 600 ./runtime-state/authority.json
```

Set these environment variables:

| Variable | Example | Purpose |
|---|---|---|
| `NAIA_ADK_PATH` | `/workspace` | ADK workspace mounted into the container |
| `NAIA_DISCORD_TOKEN_PIPE` | `stdin` | Selects the dedicated token input pipe |
| `NAIA_DISCORD_BINDINGS_JSON` | JSON shown below | Guild/channel/user allowlists, processing profiles, and optional DM binding |
| `NAIA_DISCORD_GENERATION` | `generation_1` | Must match the authority file |
| `NAIA_DISCORD_STATUS_PATH` | `/var/lib/naia-agent/status.json` | Secret-free lifecycle status file |
| `NAIA_DISCORD_AUTHORITY_PATH` | `/var/lib/naia-agent/authority.json` | Host-selected generation authority file |
| `NAIA_DISCORD_DEDUPE_PATH` | `/var/lib/naia-agent/dedupe.json` | Durable inbound-message dedupe state |

Example bindings:

```json
{
  "version": 1,
  "bindings": [
    {
      "bindingId": "server_main",
      "guildId": "100000000000000001",
      "channelId": "200000000000000001",
      "allowedUserIds": ["300000000000000001"],
      "processingProfileRef": "local_profile",
      "participation": "mentions"
    }
  ],
  "processingProfiles": { "local_profile": "local_only" },
  "dm": {
    "bindingId": "trusted_dm",
    "allowedUserIds": ["300000000000000001"],
    "processingProfileRef": "local_profile"
  }
}
```

## Start

Store the bot token in a host-side file with owner-only permissions and no trailing newline. Pipe that file to the container; do not put the token in an environment variable, command argument, settings file, or image layer. The mounted directories must be writable by the container's `node` user.

```sh
cat ./discord-token | podman run --rm -i \
  --userns=keep-id \
  --volume "$PWD/workspace:/workspace:Z" \
  --volume "$PWD/runtime-state:/var/lib/naia-agent:Z" \
  --env NAIA_ADK_PATH=/workspace \
  --env NAIA_DISCORD_TOKEN_PIPE=stdin \
  --env NAIA_DISCORD_BINDINGS_JSON='{"version":1,"bindings":[{"bindingId":"server_main","guildId":"100000000000000001","channelId":"200000000000000001","allowedUserIds":["300000000000000001"],"processingProfileRef":"local_profile","participation":"mentions"}],"processingProfiles":{"local_profile":"local_only"},"dm":{"bindingId":"trusted_dm","allowedUserIds":["300000000000000001"],"processingProfileRef":"local_profile"}}' \
  --env NAIA_DISCORD_GENERATION=generation_1 \
  --env NAIA_DISCORD_STATUS_PATH=/var/lib/naia-agent/status.json \
  --env NAIA_DISCORD_AUTHORITY_PATH=/var/lib/naia-agent/authority.json \
  --env NAIA_DISCORD_DEDUPE_PATH=/var/lib/naia-agent/dedupe.json \
  naia-agent-discord
```

The host can inspect `runtime-state/status.json` for `starting`, `ready`, `failed`, and `stopped` states. Send SIGTERM to stop cleanly. The status file, authority file, workspace, and token file contain separate data; only the workspace and state directory are mounted into the container.

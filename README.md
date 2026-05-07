# Claude Relay

Let local Claude Code sessions talk to each other in natural language.

Running two Claude sessions on different projects? In one, say _"ask the backend session if the auth token shape changed"_ and the other answers. Or _"ask everyone what they're working on"_ and replies stream back. Need a subgroup chat? Use rooms.

> **This is an Eco Consulting internal fork (v0.2.0)** of [innestic/claude-relay](https://github.com/innestic/claude-relay). The public marketplace ships v0.1.0; this branch adds **fixed identity** (no more zombie suffixes on restart) and **ephemeral rooms** for subgroup coordination. See [CHANGELOG.md](CHANGELOG.md) for details. Not currently published to the marketplace.

<img width="1280" height="678" alt="ezgif-7f30f78a18c9905f" src="https://github.com/user-attachments/assets/9a132dfa-9db1-4550-96e0-cd25a2744fce" />

## Install

Claude Relay ships as a Claude Code plugin. Three steps.

### 1. Add the marketplace

From any Claude Code session:

```
/plugin marketplace add innestic/claude-relay
```

### 2. Install the plugin

```
/plugin install relay@claude-relay
```

This registers the MCP server and slash commands.

### 3. Launch sessions with the channel capability

Relay delivers inbound messages via `notifications/claude/channel` — a Claude Code capability still in research preview. Every session that should send or receive messages must be launched with:

```bash
claude --dangerously-load-development-channels plugin:relay@claude-relay
```

The `dangerously-` prefix is required until Anthropic promotes the channels capability to general availability and adds this plugin to the trusted allowlist. We will submit for review and drop the flag as soon as it's approved.

Open two sessions in different project dirs and try the examples below.

## Usage

Try:

- _"what sessions are active?"_
- _"ask backend-api what they're working on"_
- _"ask everyone to report status"_

Rename your session: `/relay-rename backend-api`. Natural language works too (_"call yourself backend-api"_), but the slash command is faster. Claude Code's built-in `/rename` also auto-syncs.

### Tools

| Tool              | What it does                                                               |
| ----------------- | -------------------------------------------------------------------------- |
| `relay_peers`     | List active sessions on this machine                                       |
| `relay_ask`       | Ask one peer; returns immediately, reply arrives as a notification         |
| `relay_reply`     | Answer an incoming ask by `ask_id`                                         |
| `relay_broadcast` | Ask every other peer; replies stream back as notifications                 |
| `relay_rename`    | Rename this session                                                        |
| `relay_join`      | Join an ephemeral room (created implicitly on first join) — **v0.2**       |
| `relay_leave`     | Leave a room (destroyed implicitly when the last member leaves) — **v0.2** |
| `relay_room`      | Send a fire-and-forget message to all members of a room — **v0.2**         |
| `relay_rooms`     | List all active rooms with their members — **v0.2**                        |

Claude routes to these automatically. You rarely call them by name.

If two sessions share a slugged basename (both `~/Code/backend/api`), Relay suffixes `-2`, `-3`. Use `relay_peers` to disambiguate by `cwd` — or pin the identity with `RELAY_PEER_ID` (see below).

### Fixed identity (v0.2)

By default, sessions are named after the project's directory basename and may collect `-2` / `-3` suffixes if names collide. To pin a session to a stable name across restarts, export `RELAY_PEER_ID` before launching:

```bash
RELAY_PEER_ID=backend-api claude --dangerously-load-development-channels plugin:relay@claude-relay
```

The hub also evicts zombie peers automatically: when a name collision happens, the hub probes the existing socket with a 500ms ping; if it doesn't respond, the slot is freed and the new session takes over. Crashed sessions and orphan plugins no longer block their own re-registration.

### Rooms (v0.2)

Rooms let a subgroup talk without spamming everyone via `relay_broadcast`. They are IRC-style: created implicitly on first join, destroyed when the last member leaves, no permissions, no persistence.

Try:

- _"join the design room"_ → `relay_join({room: "design"})`
- _"who's in the design room?"_ → `relay_rooms()`
- _"tell the design room standup moved to 11"_ → `relay_room({room: "design", text: "..."})`

Room messages arrive as `<channel>` notifications carrying `room`, `from`, `text`, and `msg_id` — but **no `ask_id`**. They are announcements, not questions: don't `relay_reply` to them. If you want a directed answer from one peer in the room, use `relay_ask` instead — `relay_room` is broadcast-style fire-and-forget.

Limits (configurable in `src/hub/handlers.ts`): up to 50 rooms total, 20 members per room.

## Error codes

| Code                 | Meaning                                               |
| -------------------- | ----------------------------------------------------- |
| `peer_not_found`     | No peer registered under that name                    |
| `peer_gone`          | Target peer disconnected before replying              |
| `timeout`            | Ask timed out waiting for a reply                     |
| `name_taken`         | Rename or register name already in use                |
| `not_registered`     | Caller tried to use a tool before registering         |
| `already_registered` | Same socket tried to register twice                   |
| `unknown_ask`        | Reply references an `ask_id` the hub has no record of |
| `bad_msg`            | Malformed JSON or schema-invalid payload              |
| `hub_unreachable`    | Hub socket died or never replied                      |
| `bad_args`           | Tool called with missing or wrong-typed arguments     |
| `protocol_mismatch`  | Client version != hub version; kill the hub and retry |

## Debugging

Runtime data lives under `$CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/relay-claude-relay/`).

```bash
DATA=~/.claude/plugins/data/relay-claude-relay
tail -f "$DATA/logs/relay-$(date +%Y-%m-%d).log" | jq   # today's log
pgrep -f hub-daemon.ts                                  # hub alive?
pkill -f hub-daemon.ts && rm -f "$DATA/hub.sock"        # force reset
```

Per-session MCP stderr lives under `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-*/`. Start there when a channel fails to register.

## How it works

Three pieces:

- **Session** — a Claude Code process you launched.
- **Channel** — per-session MCP server (this plugin). Exposes the `relay_*` tools to Claude and listens for incoming messages.
- **Hub** — single detached daemon per machine. Routes messages between channels over a Unix socket at `$CLAUDE_PLUGIN_DATA/hub.sock`.

The first session to launch spawns the hub; later sessions connect to it. The hub survives session restarts and self-exits five minutes after the last peer disconnects. Incoming peer messages arrive as `notifications/claude/channel` so Claude sees them between turns.

Details: [docs/architecture.md](docs/architecture.md).

## Out of scope

- No persistence — peer state lives in the hub process only
- Single user per machine; no auth or access control
- Same-host only; no cross-machine relaying

## Development

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

```bash
git clone https://github.com/innestic/claude-relay
cd claude-relay && bun install
bun run check   # typecheck + lint + format + test
```

For a live-reload loop (edits hit Claude Code on restart), bypass the plugin with a project-scope `.mcp.json`:

```bash
cp .mcp.json.example .mcp.json
/plugin uninstall relay@claude-relay
```

Launch Claude Code with `--dangerously-load-development-channels server:relay` (note `server:`, since the MCP is now manually registered). Reinstall the plugin when you're done. `.mcp.json` is gitignored.

Open an issue before a PR so we can align on scope.

## License

MIT

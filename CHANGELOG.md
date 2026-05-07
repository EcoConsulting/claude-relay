# Changelog

All notable changes to this fork are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

This is an internal fork of [innestic/claude-relay](https://github.com/innestic/claude-relay) maintained by Eco Consulting. The public marketplace ships v0.1.0; this branch carries the extensions described below and is not currently distributed via the marketplace.

## [0.2.0] — 2026-05-07

Two parallel features resolving pain points found on day one of multi-agent use.

### Block 1 — Fixed identity (resolves zombie peers)

Before this block, every session restart left a zombie entry in the hub's registry; the new session got a `-2` / `-3` suffix and peers sending to the original name routed into the void. Now sessions can pin a stable identity, and zombies are evicted automatically.

#### Added

- **`RELAY_PEER_ID` environment variable**: when set, takes precedence over the basename and the Claude session name as the registered peer name. Sanitized through the existing `[A-Za-z0-9._-]{1,64}` rule; invalid values fall back through the existing resolution chain.
- **Active probe in `register()`**: when a name collides with an existing socket that still looks alive (local flags), the hub sends a `ping` with 500ms timeout. If the peer responds with `pong` the new register gets `name_taken`; otherwise the zombie is evicted and the new register succeeds. Race-protected via a per-name `registerInProgress` set.
- **Proactive sweep** (every 30s, configurable) that pings all registered peers and evicts those that don't respond. Catches orphan plugins whose Claude Code parent died but whose socket is still up.
- **Parent-death detection** in the channel: combined check of `process.ppid` change, `stdin.destroyed`, and `stdin.readableEnded`. Necessary because Windows doesn't re-parent on parent death and `process.kill(pid, 0)` is unreliable for liveness probes there.

#### Protocol

- Added `ping` / `pong` messages for probe correlation (`req_id`-based).

### Block 2 — Ephemeral rooms (resolves "no subgroup messaging")

Before this block, the only options were `relay_ask` (one-to-one) and `relay_broadcast` (everyone). Sessions can now coordinate through IRC-style ephemeral rooms.

#### Added

- **4 new MCP tools**: `relay_join`, `relay_leave`, `relay_room`, `relay_rooms`.
- **Implicit lifecycle**: rooms are created on first join, destroyed when the last member leaves. No permissions, no persistence.
- **Auto-rejoin on hub reconnect**: each channel keeps a local set of joined rooms and resends `join_room` for each on `onReconnect`.
- **Limits**: `MAX_ROOMS = 50`, `MAX_MEMBERS_PER_ROOM = 20`. Both defined in `src/hub/handlers.ts`.

#### Protocol

- `PROTOCOL_VERSION` bumped from `"2"` to `"3"`.
- New client→hub messages: `JoinRoomMsg`, `LeaveRoomMsg`, `RoomMsgMsg`, `ListRoomsMsg`.
- New hub→client messages: `RoomAckMsg`, `RoomSendAckMsg`, `IncomingRoomMsgMsg`, `RoomsListMsg`.

#### INSTRUCTIONS

Two new entries guide the model on when to use rooms vs ask, and on how to distinguish `incoming_room_msg` notifications (no `ask_id` in meta) from `incoming_ask` (with `ask_id`). The first existing entry was tightened from _"if an incoming `<channel>` message is present"_ to _"if an incoming `<channel>` message carries an `ask_id` in its meta"_ to make the distinction unambiguous.

### Tests

33 new tests: 9 protocol parsing, 8 registry unit, 9 hub handlers E2E, 7 channel tools E2E (including a baseline auto-rejoin scenario). 26 pass on Windows; 7 E2E need Unix domain sockets and pass on Linux/macOS — same constraint as the v0.1.0 test suite.

### Known debt

- **Auto-rejoin is fire-and-forget**: if a room hit `MAX_MEMBERS_PER_ROOM` while a peer was disconnected, the hub's `bad_args` reply is dropped and the channel's `joinedRooms` set drifts from hub state silently. Observable symptom: `relay_room` returns `delivered_count: 0` without diagnostic. Marked TODO in `src/channel/index.ts`; fix planned for v0.3 using `sendRequest` + cleanup.

## [0.1.0] — upstream baseline

Initial public release at [innestic/claude-relay](https://github.com/innestic/claude-relay). Tools: `relay_peers`, `relay_ask`, `relay_reply`, `relay_broadcast`, `relay_rename`. Single-host, in-memory hub, no rooms, no fixed identity.

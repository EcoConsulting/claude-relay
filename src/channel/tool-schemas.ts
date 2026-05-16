import { MAX_TEXT_LEN } from "../protocol";

export type JsonSchemaProperty = {
    type: string;
    description?: string;
    maxLength?: number;
};

export type JsonSchemaObject = {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
};

export type ToolSchema = {
    name: string;
    description: string;
    inputSchema: JsonSchemaObject;
};

export const TOOLS: ToolSchema[] = [
    {
        name: "relay_peers",
        description:
            "List OTHER active sessions on this machine. Returns `{me, peers}` where `me` is your own session name and `peers` is every other session (excluding you). Each peer has `cwd` and `git_branch` for disambiguation.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "relay_ask",
        description:
            "Ask a specific peer a question. Non-blocking: returns immediately with `{ok, ask_id}`; the reply arrives later as a channel notification whose meta carries the same `ask_id`. Errors tied to this ask (peer_not_found, peer_gone, timeout) also arrive as channel notifications. Correlate by `ask_id`. If multiple peers may share a similar name (e.g., two sessions in different projects with the same directory basename), call relay_peers first and match by `cwd` or `git_branch` to pick the right target.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                question: { type: "string", maxLength: MAX_TEXT_LEN },
                thread_id: {
                    type: "string",
                    description:
                        "Optional thread identifier to correlate multi-turn exchanges. If you received an ask with a thread_id and are replying or continuing, pass the same thread_id.",
                },
            },
            required: ["to", "question"],
        },
    },
    {
        name: "relay_reply",
        description:
            "Reply to an incoming ask by its ask_id. `text` is a plain string. Replies are one-shot — no streaming, no cancellation, no structured payload. If you need structured data, serialize JSON inside the string; the asker parses it.",
        inputSchema: {
            type: "object",
            properties: {
                ask_id: { type: "string" },
                text: { type: "string", maxLength: MAX_TEXT_LEN },
            },
            required: ["ask_id", "text"],
        },
    },
    {
        name: "relay_broadcast",
        description:
            "Broadcast a question to ALL other peers on this machine, including sessions on unrelated projects. Use ONLY when the user explicitly wants every session asked. Do NOT use as a fallback when relay_ask returns an error (peer_not_found, peer_gone, timeout); surface the error to the user and let them decide. If you want to reach a specific peer, use relay_ask.",
        inputSchema: {
            type: "object",
            properties: {
                question: { type: "string", maxLength: MAX_TEXT_LEN },
                exclude_self: { type: "boolean" },
            },
            required: ["question"],
        },
    },
    {
        name: "relay_rename",
        description: "Rename this session's registered name.",
        inputSchema: {
            type: "object",
            properties: {
                new_name: { type: "string" },
            },
            required: ["new_name"],
        },
    },
    {
        name: "relay_join",
        description:
            "Join an ephemeral room. Rooms are IRC-style: created implicitly on first join, destroyed implicitly when the last member leaves. No permissions, no persistence. Returns `{ok, room, members}` where `members` is the current membership list (including yourself). Use this to coordinate with a subgroup of peers without spamming everyone via relay_broadcast.",
        inputSchema: {
            type: "object",
            properties: {
                room: {
                    type: "string",
                    description:
                        "Room name (max 64 chars, [A-Za-z0-9._-] only). Same sanitization rules as peer names.",
                },
            },
            required: ["room"],
        },
    },
    {
        name: "relay_leave",
        description:
            "Leave a room you previously joined. Idempotent — leaving a room you are not in returns `{ok}` silently. The room is destroyed when its last member leaves.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room name to leave" },
            },
            required: ["room"],
        },
    },
    {
        name: "relay_room",
        description:
            "Send a fire-and-forget message to all members of a room (excluding yourself). Returns `{ok, room, delivered_count}` where `delivered_count` is the number of peers the hub successfully forwarded to (may be lower than total members if some are mid-reconnect). Recipients receive the message as a channel notification with `from`, `room`, `text`, and `msg_id` in meta. Use relay_ask if you need a directed reply from a specific peer; relay_room is for broadcast-to-subgroup, not request/response.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room to send to" },
                text: { type: "string", description: "Message text", maxLength: MAX_TEXT_LEN },
            },
            required: ["room", "text"],
        },
    },
    {
        name: "relay_rooms",
        description:
            "List all active rooms on this hub with their current members. Returns `{rooms: [{name, members}, ...]}`. Useful before relay_join to see if a coordination space already exists, or before relay_room to confirm membership.",
        inputSchema: { type: "object", properties: {} },
    },
];

export function getToolSchemas(): ToolSchema[] {
    return TOOLS;
}

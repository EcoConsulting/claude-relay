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
];

export function getToolSchemas(): ToolSchema[] {
    return TOOLS;
}

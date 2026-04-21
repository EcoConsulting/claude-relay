import type { ErrCode, ServerMsg } from "../protocol";

const METHOD = "notifications/claude/channel";

export type ChannelNotification = {
    method: typeof METHOD;
    params: { content: string; meta: Record<string, unknown> };
};

export function buildAskNotification(
    msg: Extract<ServerMsg, { type: "incoming_ask" }>,
): ChannelNotification {
    const meta: Record<string, unknown> = {
        from: msg.from,
        ask_id: msg.ask_id,
    };
    if (msg.broadcast_id) meta.broadcast_id = msg.broadcast_id;
    if (msg.thread_id) meta.thread_id = msg.thread_id;
    return { method: METHOD, params: { content: msg.question, meta } };
}

export function buildReplyNotification(
    msg: Extract<ServerMsg, { type: "incoming_reply" }>,
): ChannelNotification {
    const meta: Record<string, unknown> = {
        from: msg.from,
        ask_id: msg.ask_id,
    };
    if (msg.broadcast_id) meta.broadcast_id = msg.broadcast_id;
    if (msg.thread_id) meta.thread_id = msg.thread_id;
    return { method: METHOD, params: { content: msg.text, meta } };
}

export function buildAskErrorNotification(askId: string, code: ErrCode): ChannelNotification {
    return {
        method: METHOD,
        params: { content: "", meta: { ask_id: askId, code } },
    };
}

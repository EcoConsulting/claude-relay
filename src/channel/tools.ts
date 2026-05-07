import type { ErrCode } from "../protocol";
import type { HubConnection } from "./hub-connection";
import type { BroadcastAckResult, PendingBroadcasts } from "./pending-broadcasts";

export type ToolResult = {
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
};

export type ChannelContext = {
    getHub: () => HubConnection;
    pendingBroadcasts: PendingBroadcasts;
    getName: () => string;
    setName: (n: string) => void;
    nowFn: () => number;
    counters: { broadcast: number };
    broadcastTimeoutMs: number;
    requestTimeoutMs: number;
};

const errResult = (code: ErrCode): ToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, code }) }],
});

const okResult = (payload: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

const broadcastResultToTool = (r: BroadcastAckResult): ToolResult => {
    if (r.ok) return okResult({ ok: true, broadcast_id: r.broadcast_id, peer_count: r.peer_count });
    return errResult(r.code);
};

export async function relayPeers(ctx: ChannelContext): Promise<ToolResult> {
    const reply = await ctx.getHub().sendRequest({ type: "list_peers" }, ctx.requestTimeoutMs);
    if (reply.type !== "peers") {
        return errResult((reply as { code?: ErrCode }).code ?? "unexpected");
    }
    return okResult({ me: ctx.getName(), peers: reply.peers });
}

export type RenameResult = { ok: true } | { ok: false; code: ErrCode };

export async function renameWithHub(ctx: ChannelContext, newName: string): Promise<RenameResult> {
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "rename", new_name: newName }, ctx.requestTimeoutMs);
    if (reply.type === "ack") {
        ctx.setName(newName);
        return { ok: true };
    }
    if (reply.type === "err") return { ok: false, code: reply.code };
    return { ok: false, code: "unexpected" };
}

export async function relayRename(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const newName = args.new_name;
    if (typeof newName !== "string") return errResult("bad_args");
    const result = await renameWithHub(ctx, newName);
    if (result.ok) return okResult({ ok: true, name: newName });
    return errResult(result.code);
}

export async function relayAsk(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const to = args.to;
    const question = args.question;
    if (typeof to !== "string" || typeof question !== "string") return errResult("bad_args");
    const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
    const askId = crypto.randomUUID();
    ctx.getHub().send({
        type: "ask",
        to,
        question,
        ask_id: askId,
        ...(threadId ? { thread_id: threadId } : {}),
    });
    return okResult({ ok: true, ask_id: askId });
}

export async function relayReply(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const askId = args.ask_id;
    const text = args.text;
    if (typeof askId !== "string" || typeof text !== "string") return errResult("bad_args");
    ctx.getHub().send({ type: "reply", ask_id: askId, text });
    return okResult({ ok: true });
}

export async function relayBroadcast(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const question = args.question;
    if (typeof question !== "string") return errResult("bad_args");
    const excludeSelf = typeof args.exclude_self === "boolean" ? args.exclude_self : true;
    const broadcastId = `bcast-${ctx.getName()}-${++ctx.counters.broadcast}-${ctx.nowFn()}`;
    const pending = ctx.pendingBroadcasts.create(broadcastId, ctx.broadcastTimeoutMs);
    ctx.getHub().send({
        type: "broadcast",
        question,
        broadcast_id: broadcastId,
        exclude_self: excludeSelf,
    });
    return broadcastResultToTool(await pending);
}

export async function relayJoin(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    if (typeof room !== "string") return errResult("bad_args");
    const reply = await ctx.getHub().sendRequest({ type: "join_room", room }, ctx.requestTimeoutMs);
    if (reply.type === "room_ack") {
        return okResult({ ok: true, room: reply.room, members: reply.members });
    }
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayLeave(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    if (typeof room !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "leave_room", room }, ctx.requestTimeoutMs);
    if (reply.type === "ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayRoomMsg(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    const text = args.text;
    if (typeof room !== "string" || typeof text !== "string") return errResult("bad_args");
    const msgId = crypto.randomUUID();
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "room_msg", room, text, msg_id: msgId }, ctx.requestTimeoutMs);
    if (reply.type === "room_send_ack") {
        return okResult({ ok: true, room: reply.room, delivered_count: reply.delivered_count });
    }
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayListRooms(ctx: ChannelContext): Promise<ToolResult> {
    const reply = await ctx.getHub().sendRequest({ type: "list_rooms" }, ctx.requestTimeoutMs);
    if (reply.type === "rooms_list") return okResult({ rooms: reply.rooms });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function callTool(
    ctx: ChannelContext,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    switch (name) {
        case "relay_peers":
            return relayPeers(ctx);
        case "relay_rename":
            return relayRename(ctx, args);
        case "relay_ask":
            return relayAsk(ctx, args);
        case "relay_reply":
            return relayReply(ctx, args);
        case "relay_broadcast":
            return relayBroadcast(ctx, args);
        case "relay_join":
            return relayJoin(ctx, args);
        case "relay_leave":
            return relayLeave(ctx, args);
        case "relay_room":
            return relayRoomMsg(ctx, args);
        case "relay_rooms":
            return relayListRooms(ctx);
        default:
            return { isError: true, content: [{ type: "text", text: "not_implemented" }] };
    }
}

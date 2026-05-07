import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../identity";
import { makeLogger } from "../logger";
import {
    PROTOCOL_VERSION,
    type AskMsg,
    type BroadcastMsg,
    type JoinRoomMsg,
    type LeaveRoomMsg,
    type ListPeersMsg,
    type ListRoomsMsg,
    type RegisterMsg,
    type RenameMsg,
    type ReplyMsg,
    type RoomMsgMsg,
    type ServerMsg,
} from "../protocol";
import type { PendingAsks } from "./pending-asks";
import type { PeerRegistry } from "./registry";

const log = makeLogger("hub");

export const MAX_ROOMS = 50;
export const MAX_MEMBERS_PER_ROOM = 20;

export type HubContext = {
    registry: PeerRegistry;
    pendingAsks: PendingAsks;
    defaultAskTimeoutMs: number;
    sendTo: (name: string, msg: ServerMsg) => boolean;
};

type Send = (m: ServerMsg) => void;

export async function handleRegister(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RegisterMsg>,
    send: Send,
): Promise<void> {
    if (msg.protocol_version !== PROTOCOL_VERSION) {
        log.warn("register_protocol_mismatch", {
            name: msg.name,
            client_version: msg.protocol_version,
            hub_version: PROTOCOL_VERSION,
        });
        return send({ type: "err", code: "protocol_mismatch" });
    }
    const result = await ctx.registry.register(socket, msg);
    if (result === "already_registered") return send({ type: "err", code: "already_registered" });
    if (result === "name_taken") return send({ type: "err", code: "name_taken" });
    send({ type: "ack" });
}

export function handleRename(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RenameMsg>,
    send: Send,
): void {
    const reqId = msg.req_id;
    const tail = reqId ? { req_id: reqId } : {};
    const current = ctx.registry.getName(socket);
    const result = ctx.registry.rename(socket, msg.new_name);
    if (result === "not_registered") return send({ type: "err", code: "not_registered", ...tail });
    if (result === "name_taken") return send({ type: "err", code: "name_taken", ...tail });
    if (result === "ok" && current) ctx.pendingAsks.updateNameOnRename(current, msg.new_name);
    send({ type: "ack", ...tail });
}

export function handleListPeers(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ListPeersMsg>,
    send: Send,
): void {
    const selfName = ctx.registry.getName(socket);
    const list = ctx.registry.list(selfName);
    log.debug("list_peers", { caller: selfName, peer_count: list.length });
    send({ type: "peers", peers: list, ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleAsk(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof AskMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        log.warn("ask_undeliverable", {
            from: "?",
            to: msg.to,
            ask_id: msg.ask_id,
            code: "not_registered",
        });
        return send({ type: "err", code: "not_registered" });
    }
    log.debug("ask_received", { from: caller, to: msg.to, ask_id: msg.ask_id });
    if (!ctx.registry.hasName(msg.to)) {
        log.warn("ask_undeliverable", {
            from: caller,
            to: msg.to,
            ask_id: msg.ask_id,
            code: "peer_not_found",
        });
        return send({ type: "err", code: "peer_not_found", ask_id: msg.ask_id });
    }
    const timeoutMs = msg.timeout_ms ?? ctx.defaultAskTimeoutMs;
    const threadId = msg.thread_id ?? crypto.randomUUID();
    ctx.pendingAsks.create(
        msg.ask_id,
        { caller, target: msg.to, thread_id: threadId },
        timeoutMs,
        () => {
            log.warn("pending_ask_timeout", { ask_id: msg.ask_id, caller, target: msg.to });
            ctx.sendTo(caller, { type: "err", code: "timeout", ask_id: msg.ask_id });
        },
    );
    const delivered = ctx.sendTo(msg.to, {
        type: "incoming_ask",
        from: caller,
        question: msg.question,
        ask_id: msg.ask_id,
        thread_id: threadId,
    });
    if (delivered) {
        log.debug("ask_delivered", { from: caller, to: msg.to, ask_id: msg.ask_id });
    } else {
        log.warn("ask_undeliverable", {
            from: caller,
            to: msg.to,
            ask_id: msg.ask_id,
            reason: "send_failed",
        });
    }
}

export function handleReply(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ReplyMsg>,
    send: Send,
): void {
    const replier = ctx.registry.getName(socket);
    if (!replier) {
        log.warn("reply_err", { code: "not_registered", ask_id: msg.ask_id });
        return send({ type: "err", code: "not_registered" });
    }
    const peeked = ctx.pendingAsks.peek(msg.ask_id);
    if (!peeked) {
        log.warn("reply_err", { code: "unknown_ask", ask_id: msg.ask_id });
        return send({ type: "err", code: "unknown_ask" });
    }
    if (peeked.target !== replier) {
        log.warn("reply_err", {
            code: "unknown_ask",
            ask_id: msg.ask_id,
            replier,
            expected_target: peeked.target,
            reason: "replier_not_target",
        });
        return send({ type: "err", code: "unknown_ask" });
    }
    ctx.pendingAsks.resolve(msg.ask_id);
    log.debug("reply_received", {
        from: replier,
        ask_id: msg.ask_id,
        original_caller: peeked.caller,
    });
    ctx.sendTo(peeked.caller, {
        type: "incoming_reply",
        from: replier,
        text: msg.text,
        ask_id: msg.ask_id,
        ...(peeked.broadcast_id ? { broadcast_id: peeked.broadcast_id } : {}),
        ...(peeked.thread_id ? { thread_id: peeked.thread_id } : {}),
    });
}

export function handleBroadcast(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof BroadcastMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        log.warn("broadcast_err", { code: "not_registered", broadcast_id: msg.broadcast_id });
        return send({ type: "err", code: "not_registered" });
    }
    const excludeSelf = msg.exclude_self ?? true;
    const threadId = msg.broadcast_id;
    let peerCount = 0;
    for (const name of ctx.registry.names()) {
        if (excludeSelf && name === caller) continue;
        peerCount++;
        const askId = `${msg.broadcast_id}:${name}`;
        ctx.pendingAsks.create(
            askId,
            { caller, target: name, broadcast_id: msg.broadcast_id, thread_id: threadId },
            ctx.defaultAskTimeoutMs,
            () => {},
        );
        ctx.sendTo(name, {
            type: "incoming_ask",
            from: caller,
            question: msg.question,
            ask_id: askId,
            broadcast_id: msg.broadcast_id,
            thread_id: threadId,
        });
    }
    log.info("broadcast", { from: caller, broadcast_id: msg.broadcast_id, peer_count: peerCount });
    send({ type: "broadcast_ack", broadcast_id: msg.broadcast_id, peer_count: peerCount });
}

export function handleJoinRoom(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof JoinRoomMsg>,
    send: Send,
): void {
    const name = ctx.registry.getName(socket);
    if (!name) {
        log.warn("join_room_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("join_room_err", {
            code: "bad_args",
            reason: "invalid_room_name",
            room: msg.room,
        });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const existingMembers = ctx.registry.getRoomMembers(sanitized);
    const isExistingRoom = existingMembers.length > 0;
    if (!isExistingRoom && ctx.registry.listRooms().length >= MAX_ROOMS) {
        log.warn("join_room_err", { code: "bad_args", reason: "room_limit", room: sanitized });
        return send({
            type: "err",
            code: "bad_args",
            message: `room_limit_reached (max ${MAX_ROOMS})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    if (!existingMembers.includes(name) && existingMembers.length >= MAX_MEMBERS_PER_ROOM) {
        log.warn("join_room_err", { code: "bad_args", reason: "member_limit", room: sanitized });
        return send({
            type: "err",
            code: "bad_args",
            message: `member_limit_reached (max ${MAX_MEMBERS_PER_ROOM})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const members = ctx.registry.joinRoom(name, sanitized);
    log.info("join_room", { peer: name, room: sanitized, members: members.length });
    send({
        type: "room_ack",
        room: sanitized,
        members,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleLeaveRoom(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof LeaveRoomMsg>,
    send: Send,
): void {
    const name = ctx.registry.getName(socket);
    if (!name) {
        log.warn("leave_room_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("leave_room_err", {
            code: "bad_args",
            reason: "invalid_room_name",
            room: msg.room,
        });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    ctx.registry.leaveRoom(name, sanitized);
    log.info("leave_room", { peer: name, room: sanitized });
    send({ type: "ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleRoomMsg(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RoomMsgMsg>,
    send: Send,
): void {
    const sender = ctx.registry.getName(socket);
    if (!sender) {
        log.warn("room_msg_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("room_msg_err", { code: "bad_args", reason: "invalid_room_name", room: msg.room });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const members = ctx.registry.getRoomMembers(sanitized);
    let deliveredCount = 0;
    for (const member of members) {
        if (member === sender) continue;
        const delivered = ctx.sendTo(member, {
            type: "incoming_room_msg",
            room: sanitized,
            from: sender,
            text: msg.text,
            msg_id: msg.msg_id,
        });
        if (delivered) deliveredCount++;
    }
    log.info("room_msg", {
        from: sender,
        room: sanitized,
        msg_id: msg.msg_id,
        delivered_count: deliveredCount,
    });
    send({
        type: "room_send_ack",
        room: sanitized,
        delivered_count: deliveredCount,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleListRooms(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ListRoomsMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    const roomsList = ctx.registry.listRooms();
    log.debug("list_rooms", { caller, count: roomsList.length });
    send({
        type: "rooms_list",
        rooms: roomsList,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

import { z } from "zod";
import { hubSocketPath } from "./data-dir";

export const PROTOCOL_VERSION = "2";

// 512 KiB body cap leaves headroom under the 1 MiB framing.MAX_LINE_LEN for JSON envelope and escapes.
export const MAX_TEXT_LEN = 512 * 1024;

export const RegisterMsg = z.object({
    type: z.literal("register"),
    name: z.string(),
    cwd: z.string(),
    git_branch: z.string(),
    protocol_version: z.string(),
});

export const RenameMsg = z.object({
    type: z.literal("rename"),
    new_name: z.string(),
    req_id: z.string().optional(),
});

export const ListPeersMsg = z.object({
    type: z.literal("list_peers"),
    req_id: z.string().optional(),
});

export const AskMsg = z.object({
    type: z.literal("ask"),
    to: z.string(),
    question: z.string().max(MAX_TEXT_LEN),
    ask_id: z.string(),
    timeout_ms: z.number().optional(),
    thread_id: z.string().optional(),
});

export const ReplyMsg = z.object({
    type: z.literal("reply"),
    ask_id: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
});

export const BroadcastMsg = z.object({
    type: z.literal("broadcast"),
    question: z.string().max(MAX_TEXT_LEN),
    broadcast_id: z.string(),
    exclude_self: z.boolean().optional(),
});

export const ClientMsgSchema = z.discriminatedUnion("type", [
    RegisterMsg,
    RenameMsg,
    ListPeersMsg,
    AskMsg,
    ReplyMsg,
    BroadcastMsg,
]);

export const AckMsg = z.object({
    type: z.literal("ack"),
    req_id: z.string().optional(),
});

export const ErrCodeSchema = z.enum([
    "peer_not_found",
    "peer_gone",
    "timeout",
    "name_taken",
    "not_registered",
    "already_registered",
    "unknown_ask",
    "bad_msg",
    "hub_unreachable",
    "bad_args",
    "protocol_mismatch",
    "unexpected",
]);

export type ErrCode = z.infer<typeof ErrCodeSchema>;

export const ErrMsg = z.object({
    type: z.literal("err"),
    code: ErrCodeSchema,
    message: z.string().optional(),
    req_id: z.string().optional(),
    ask_id: z.string().optional(),
});

export const PeerRecordSchema = z.object({
    name: z.string(),
    cwd: z.string(),
    git_branch: z.string(),
    last_seen: z.number(),
});

export const PeersMsg = z.object({
    type: z.literal("peers"),
    peers: z.array(PeerRecordSchema),
    req_id: z.string().optional(),
});

export const IncomingAskMsg = z.object({
    type: z.literal("incoming_ask"),
    from: z.string(),
    question: z.string().max(MAX_TEXT_LEN),
    ask_id: z.string(),
    broadcast_id: z.string().optional(),
    thread_id: z.string().optional(),
});

export const IncomingReplyMsg = z.object({
    type: z.literal("incoming_reply"),
    from: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
    ask_id: z.string(),
    broadcast_id: z.string().optional(),
    thread_id: z.string().optional(),
});

export const BroadcastAckMsg = z.object({
    type: z.literal("broadcast_ack"),
    broadcast_id: z.string(),
    peer_count: z.number(),
});

export const ServerMsgSchema = z.discriminatedUnion("type", [
    AckMsg,
    ErrMsg,
    PeersMsg,
    IncomingAskMsg,
    IncomingReplyMsg,
    BroadcastAckMsg,
]);

export type ClientMsg = z.infer<typeof ClientMsgSchema>;
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
export type PeerRecord = z.infer<typeof PeerRecordSchema>;

export const HUB_SOCKET_PATH: string = hubSocketPath();

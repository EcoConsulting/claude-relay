import { describe, expect, test } from "bun:test";
import {
    AckMsg,
    AskMsg,
    BroadcastMsg,
    ClientMsgSchema,
    ErrCodeSchema,
    ErrMsg,
    IncomingAskMsg,
    IncomingReplyMsg,
    ListPeersMsg,
    PeersMsg,
    PROTOCOL_VERSION,
    RegisterMsg,
    RenameMsg,
    ReplyMsg,
    ServerMsgSchema,
} from "./protocol";

describe("protocol client messages", () => {
    test("register round-trips", () => {
        const m = {
            type: "register" as const,
            name: "alice",
            cwd: "/tmp",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        };
        expect(RegisterMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("register rejects payload without protocol_version", () => {
        expect(() =>
            RegisterMsg.parse({
                type: "register",
                name: "alice",
                cwd: "/tmp",
                git_branch: "main",
            }),
        ).toThrow();
    });

    test("PROTOCOL_VERSION is defined as a string", () => {
        expect(typeof PROTOCOL_VERSION).toBe("string");
        expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
    });

    test("PROTOCOL_VERSION is '2'", () => {
        expect(PROTOCOL_VERSION).toBe("2");
    });

    test("ErrCodeSchema accepts protocol_mismatch", () => {
        expect(ErrCodeSchema.parse("protocol_mismatch")).toBe("protocol_mismatch");
    });

    test("rename round-trips", () => {
        const m = { type: "rename" as const, new_name: "bob" };
        expect(RenameMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("rename accepts optional req_id", () => {
        const m = { type: "rename" as const, new_name: "bob", req_id: "r1" };
        expect(RenameMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("list_peers round-trips", () => {
        const m = { type: "list_peers" as const };
        expect(ListPeersMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("list_peers accepts optional req_id", () => {
        const m = { type: "list_peers" as const, req_id: "r7" };
        expect(ListPeersMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("ask round-trips", () => {
        const m = { type: "ask" as const, to: "bob", question: "hi?", ask_id: "a1" };
        expect(AskMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("ask accepts optional timeout_ms", () => {
        const m = {
            type: "ask" as const,
            to: "bob",
            question: "hi?",
            ask_id: "a1",
            timeout_ms: 5000,
        };
        expect(AskMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("reply round-trips", () => {
        const m = { type: "reply" as const, ask_id: "a1", text: "yes" };
        expect(ReplyMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("broadcast round-trips (with and without exclude_self)", () => {
        const m1 = { type: "broadcast" as const, question: "?", broadcast_id: "b1" };
        expect(BroadcastMsg.parse(m1)).toEqual(m1);
        const m2 = {
            type: "broadcast" as const,
            question: "?",
            broadcast_id: "b1",
            exclude_self: true,
        };
        expect(BroadcastMsg.parse(m2)).toEqual(m2);
    });

    test("rejects malformed register", () => {
        expect(() => ClientMsgSchema.parse({ type: "register", name: "x" })).toThrow();
        expect(() =>
            ClientMsgSchema.parse({ type: "register", name: 1, cwd: "/", git_branch: "m" }),
        ).toThrow();
    });

    test("rejects unknown type", () => {
        expect(() => ClientMsgSchema.parse({ type: "nope" })).toThrow();
    });
});

describe("protocol server messages", () => {
    test("ack round-trips", () => {
        expect(AckMsg.parse({ type: "ack" })).toEqual({ type: "ack" });
        expect(AckMsg.parse({ type: "ack", req_id: "r1" })).toEqual({ type: "ack", req_id: "r1" });
    });

    test("err round-trips", () => {
        const m = { type: "err" as const, code: "bad_msg" as const, message: "x", req_id: "r1" };
        expect(ErrMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse({ type: "err", code: "bad_msg" })).toBeTruthy();
    });

    test("peers round-trips", () => {
        const m = {
            type: "peers" as const,
            peers: [{ name: "a", cwd: "/", git_branch: "m", last_seen: 1 }],
        };
        expect(PeersMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("incoming_ask round-trips", () => {
        const m = { type: "incoming_ask" as const, from: "a", question: "?", ask_id: "a1" };
        expect(IncomingAskMsg.parse(m)).toEqual(m);
    });

    test("incoming_reply round-trips", () => {
        const m = {
            type: "incoming_reply" as const,
            from: "a",
            text: "x",
            ask_id: "a1",
            broadcast_id: "b1",
        };
        expect(IncomingReplyMsg.parse(m)).toEqual(m);
    });

    test("ask/incoming_ask/incoming_reply accept optional thread_id; reply does not carry one", () => {
        const ask = {
            type: "ask" as const,
            to: "bob",
            question: "hi?",
            ask_id: "a1",
            thread_id: "t1",
        };
        expect(AskMsg.parse(ask)).toEqual(ask);

        const reply = { type: "reply" as const, ask_id: "a1", text: "y" };
        expect(ReplyMsg.parse(reply)).toEqual(reply);
        // thread_id on the wire is stripped by zod — hub resolves it from the pending entry.
        const replyWithZombie = { ...reply, thread_id: "t1" };
        expect(ReplyMsg.parse(replyWithZombie)).toEqual(reply);

        const incomingAsk = {
            type: "incoming_ask" as const,
            from: "a",
            question: "?",
            ask_id: "a1",
            thread_id: "t1",
        };
        expect(IncomingAskMsg.parse(incomingAsk)).toEqual(incomingAsk);

        const incomingReply = {
            type: "incoming_reply" as const,
            from: "a",
            text: "x",
            ask_id: "a1",
            thread_id: "t1",
        };
        expect(IncomingReplyMsg.parse(incomingReply)).toEqual(incomingReply);
    });
});

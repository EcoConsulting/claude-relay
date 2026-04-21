import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../protocol";
import { startHub, type PendingAsk } from "./index";
import { createPendingAsks } from "./pending-asks";
import { rawConnect, tmpSocket } from "./test-helpers";

describe("hub pending asks", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("ask routes to target as incoming_ask with caller name as from", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        const incoming = await b.next();
        expect(incoming.type).toBe("incoming_ask");
        if (incoming.type === "incoming_ask") {
            expect(incoming.from).toBe("alice");
            expect(incoming.question).toBe("hi?");
            expect(incoming.ask_id).toBe("a1");
        }
        a.close();
        b.close();
    });

    test("reply routes back to original asker as incoming_reply", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        await b.next(); // incoming_ask

        b.send({ type: "reply", ask_id: "a1", text: "yo" });
        const incomingReply = await a.next();
        expect(incomingReply.type).toBe("incoming_reply");
        if (incomingReply.type === "incoming_reply") {
            expect(incomingReply.from).toBe("bob");
            expect(incomingReply.text).toBe("yo");
            expect(incomingReply.ask_id).toBe("a1");
        }
        a.close();
        b.close();
    });

    test("reply with unknown ask_id returns err unknown_ask", async () => {
        const b = await rawConnect(sockPath);
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        b.send({ type: "reply", ask_id: "nope", text: "x" });
        const reply = await b.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("unknown_ask");
        b.close();
    });

    test("pending ask expires after default timeout and entry is cleaned up", async () => {
        await hub.close();
        sockPath = tmpSocket();
        const pending = new Map<string, PendingAsk>();
        hub = await startHub({
            socketPath: sockPath,
            defaultAskTimeoutMs: 50,
            pendingAsks: pending,
        });

        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        await b.next(); // incoming_ask
        expect(pending.has("a1")).toBe(true);

        await new Promise((r) => setTimeout(r, 120));
        expect(pending.has("a1")).toBe(false);

        a.close();
        b.close();
    });

    test("ask timeout_ms override triggers cleanup even when default is large", async () => {
        await hub.close();
        sockPath = tmpSocket();
        const pending = new Map<string, PendingAsk>();
        hub = await startHub({
            socketPath: sockPath,
            defaultAskTimeoutMs: 60_000,
            pendingAsks: pending,
        });

        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1", timeout_ms: 40 });
        await b.next();
        expect(pending.has("a1")).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
        expect(pending.has("a1")).toBe(false);

        a.close();
        b.close();
    });

    test("reply removes pending entry", async () => {
        await hub.close();
        sockPath = tmpSocket();
        const pending = new Map<string, PendingAsk>();
        hub = await startHub({
            socketPath: sockPath,
            defaultAskTimeoutMs: 60_000,
            pendingAsks: pending,
        });

        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        await b.next();
        expect(pending.has("a1")).toBe(true);
        b.send({ type: "reply", ask_id: "a1", text: "yo" });
        await a.next();
        expect(pending.has("a1")).toBe(false);

        a.close();
        b.close();
    });

    test("distinct ask_ids from same caller survive rename without collision", () => {
        const pending = createPendingAsks();
        pending.create("ask-1", { caller: "alice", target: "bob" }, 60_000, () => {});

        pending.updateNameOnRename("alice", "alice2");

        pending.create("ask-2", { caller: "alice2", target: "bob" }, 60_000, () => {});

        const first = pending.resolve("ask-1");
        expect(first).toBeDefined();
        expect(first?.caller).toBe("alice2");
        expect(first?.target).toBe("bob");

        const second = pending.resolve("ask-2");
        expect(second).toBeDefined();
        expect(second?.caller).toBe("alice2");
        expect(second?.target).toBe("bob");

        pending.clearAll();
    });

    test("rename migrates pendingAsks so replies route to the new name", async () => {
        await hub.close();
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath, defaultAskTimeoutMs: 60_000 });

        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        await b.next(); // incoming_ask on b

        a.send({ type: "rename", new_name: "alicia" });
        const renameAck = await a.next();
        expect(renameAck.type).toBe("ack");

        b.send({ type: "reply", ask_id: "a1", text: "yo" });
        const reply = await a.next();
        expect(reply.type).toBe("incoming_reply");
        if (reply.type === "incoming_reply") {
            expect(reply.text).toBe("yo");
            expect(reply.ask_id).toBe("a1");
        }
        a.close();
        b.close();
    });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { PROTOCOL_VERSION } from "../protocol";
import { startHub, type PendingAsk } from "./index";
import { rawConnect, tmpSocket } from "./test-helpers";

describe("hub lifecycle", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("socket file mode is 0o600 after hub starts", () => {
        if (process.platform === "win32") return; // Windows doesn't support Unix file permissions
        expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);
    });

    test("idle timer fires when peer count drops to 0", async () => {
        await hub.close();
        sockPath = tmpSocket();
        let fired = false;
        hub = await startHub({
            socketPath: sockPath,
            idleExitMs: 50,
            onIdleExit: () => {
                fired = true;
            },
        });

        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.close();

        await new Promise((r) => setTimeout(r, 150));
        expect(fired).toBe(true);
    });

    test("connecting a peer during idle timer window cancels it", async () => {
        await hub.close();
        sockPath = tmpSocket();
        let fired = false;
        hub = await startHub({
            socketPath: sockPath,
            idleExitMs: 100,
            onIdleExit: () => {
                fired = true;
            },
        });

        // Start with no peers — idle timer should be running
        await new Promise((r) => setTimeout(r, 30));
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();

        await new Promise((r) => setTimeout(r, 150));
        expect(fired).toBe(false);
        a.close();
    });

    test("disconnect target with pending ask delivers err peer_gone to asker and cleans pending", async () => {
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

        b.close();

        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") {
            expect(reply.code).toBe("peer_gone");
            expect(reply.ask_id).toBe("a1");
        }
        expect(pending.has("a1")).toBe(false);

        a.close();
    });

    test("broadcast churn: targets and caller disconnect, idle timer fires once with empty pending", async () => {
        await hub.close();
        sockPath = tmpSocket();
        const pending = new Map<string, PendingAsk>();
        let idleExitCount = 0;
        hub = await startHub({
            socketPath: sockPath,
            defaultAskTimeoutMs: 60_000,
            idleExitMs: 200,
            pendingAsks: pending,
            onIdleExit: () => {
                idleExitCount++;
            },
        });

        const caller = await rawConnect(sockPath);
        const t1 = await rawConnect(sockPath);
        const t2 = await rawConnect(sockPath);
        caller.send({
            type: "register",
            name: "caller",
            cwd: "/tmp/c",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await caller.next();
        t1.send({
            type: "register",
            name: "t1",
            cwd: "/tmp/1",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await t1.next();
        t2.send({
            type: "register",
            name: "t2",
            cwd: "/tmp/2",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await t2.next();

        const broadcastId = "bc-1";
        caller.send({ type: "broadcast", question: "anyone there?", broadcast_id: broadcastId });

        // Drain incoming_ask at each target + broadcast_ack at caller (any order).
        await t1.next();
        await t2.next();
        const ack = await caller.next();
        expect(ack.type).toBe("broadcast_ack");
        if (ack.type === "broadcast_ack") {
            expect(ack.broadcast_id).toBe(broadcastId);
            expect(ack.peer_count).toBe(2);
        }
        expect(pending.size).toBe(2);

        // Both targets disconnect before replying.
        t1.close();
        t2.close();

        // Caller receives two peer_gone errs, one per target.
        const err1 = await caller.next();
        const err2 = await caller.next();
        const goneAskIds: string[] = [];
        for (const e of [err1, err2]) {
            expect(e.type).toBe("err");
            if (e.type === "err") {
                expect(e.code).toBe("peer_gone");
                expect(e.ask_id).toBeDefined();
                if (e.ask_id) goneAskIds.push(e.ask_id);
            }
        }
        expect(goneAskIds.sort()).toEqual([`${broadcastId}:t1`, `${broadcastId}:t2`]);

        // Caller disconnects too — hub is now peer-less with no lingering pendings.
        caller.close();
        await new Promise((r) => setTimeout(r, 50));
        expect(pending.size).toBe(0);

        // Wait past idleExitMs; onIdleExit fires exactly once, no crash.
        await new Promise((r) => setTimeout(r, 400));
        expect(idleExitCount).toBe(1);
        expect(pending.size).toBe(0);
    });

    test("disconnect asker with pending ask cleans pending without crashing", async () => {
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

        a.close();
        await new Promise((r) => setTimeout(r, 50));
        expect(pending.has("a1")).toBe(false);

        // Hub still responsive
        b.send({ type: "list_peers" });
        const peers = await b.next();
        expect(peers.type).toBe("peers");
    });

    test("hub ask timer fires: caller receives err timeout before any peer_gone", async () => {
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
        // Target gets incoming_ask but never replies
        await b.next();
        expect(pending.has("a1")).toBe(true);

        // Hub's 50ms timer should fire and surface timeout to caller
        const err = await a.next();
        expect(err.type).toBe("err");
        if (err.type === "err") {
            expect(err.code).toBe("timeout");
            expect(err.ask_id).toBe("a1");
        }
        expect(pending.has("a1")).toBe(false);

        a.close();
        b.close();
    });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as net from "node:net";
import { PROTOCOL_VERSION } from "../protocol";
import { startHub } from "./index";
import { createPeerRegistry } from "./registry";
import { rawConnect, tmpSocket } from "./test-helpers";

const fakeSocket = () => ({}) as unknown as net.Socket;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("hub registry", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("register returns ack", async () => {
        const c = await rawConnect(sockPath);
        c.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        const reply = await c.next();
        expect(reply.type).toBe("ack");
        c.close();
    });

    test("list_peers returns peers excluding self", async () => {
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

        a.send({ type: "list_peers" });
        const reply = await a.next();
        expect(reply.type).toBe("peers");
        if (reply.type === "peers") {
            expect(reply.peers.map((p) => p.name).sort()).toEqual(["bob"]);
            const peer = reply.peers[0]!;
            expect(peer.cwd).toBe("/tmp/b");
            expect(peer.git_branch).toBe("dev");
            expect(typeof peer.last_seen).toBe("number");
        }
        a.close();
        b.close();
    });

    test("rename to unused name acks and list_peers reflects new name", async () => {
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

        a.send({ type: "rename", new_name: "alicia" });
        const reply = await a.next();
        expect(reply.type).toBe("ack");

        b.send({ type: "list_peers" });
        const peers = await b.next();
        expect(peers.type).toBe("peers");
        if (peers.type === "peers") {
            expect(peers.peers.map((p) => p.name).sort()).toEqual(["alicia"]);
        }
        a.close();
        b.close();
    });

    test("rename to name held by another peer errs name_taken, both remain", async () => {
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

        a.send({ type: "rename", new_name: "bob" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("name_taken");

        // Both entries still present - list from a third peer
        const c = await rawConnect(sockPath);
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "x",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();
        c.send({ type: "list_peers" });
        const peers = await c.next();
        if (peers.type === "peers") {
            expect(peers.peers.map((p) => p.name).sort()).toEqual(["alice", "bob"]);
        }
        a.close();
        b.close();
        c.close();
    });

    test("rename to own current name is a noop ack", async () => {
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

        a.send({ type: "rename", new_name: "alice" });
        const reply = await a.next();
        expect(reply.type).toBe("ack");

        b.send({ type: "list_peers" });
        const peers = await b.next();
        if (peers.type === "peers") {
            expect(peers.peers.map((p) => p.name).sort()).toEqual(["alice"]);
        }
        a.close();
        b.close();
    });

    test("rename before register errs not_registered", async () => {
        const a = await rawConnect(sockPath);
        a.send({ type: "rename", new_name: "alicia" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("not_registered");
        a.close();
    });

    test("touch updates last_seen for registered socket", async () => {
        const registry = createPeerRegistry();
        const socket = fakeSocket();
        registry.register(socket, { name: "alice", cwd: "/tmp/a", git_branch: "main" });
        const initial = registry.list()[0]!.last_seen;

        await sleep(10);
        registry.touch(socket);

        const after = registry.list()[0]!.last_seen;
        expect(after).toBeGreaterThan(initial);
    });

    test("re-register from same socket errs already_registered and keeps first name", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        const first = await a.next();
        expect(first.type).toBe("ack");

        a.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        const second = await a.next();
        expect(second.type).toBe("err");
        if (second.type === "err") expect(second.code).toBe("already_registered");

        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe",
            cwd: "/tmp/p",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await probe.next();
        probe.send({ type: "list_peers" });
        const peers = await probe.next();
        if (peers.type === "peers") {
            expect(peers.peers.map((p) => p.name).sort()).toEqual(["alice"]);
        }
        a.close();
        probe.close();
    });
});

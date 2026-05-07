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

describe("zombie eviction in register", () => {
    const liveSocket = () => ({ destroyed: false, writable: true }) as unknown as net.Socket;

    // Socket mock that auto-replies "pong" to any "ping" written to it,
    // simulating a fully alive peer.
    function aliveRespondingSocket(registry: ReturnType<typeof createPeerRegistry>): net.Socket {
        const sock = {
            destroyed: false,
            writable: true,
            write(data: string): boolean {
                try {
                    const obj = JSON.parse(data.trim()) as { type?: string; req_id?: string };
                    if (obj.type === "ping" && typeof obj.req_id === "string") {
                        queueMicrotask(() => registry.handlePong(obj.req_id!));
                    }
                } catch {}
                return true;
            },
        };
        return sock as unknown as net.Socket;
    }

    test("evicts socket marked destroyed and allows re-registration with same name", async () => {
        const registry = createPeerRegistry();
        const socketA = liveSocket();
        const socketB = liveSocket();

        const r1 = await registry.register(socketA, { name: "inv", cwd: "/a", git_branch: "" });
        expect(r1).toBe("ok");

        // Simulate crash: socket marked destroyed without explicit removeBySocket call
        (socketA as unknown as { destroyed: boolean }).destroyed = true;

        const r2 = await registry.register(socketB, { name: "inv", cwd: "/b", git_branch: "" });
        expect(r2).toBe("ok");
        expect(registry.getName(socketB)).toBe("inv");
        expect(registry.getName(socketA)).toBeUndefined();
    });

    test("evicts socket marked not writable and allows re-registration", async () => {
        const registry = createPeerRegistry();
        const socketA = liveSocket();
        const socketB = liveSocket();

        await registry.register(socketA, { name: "inv", cwd: "/a", git_branch: "" });
        (socketA as unknown as { writable: boolean }).writable = false;

        const r = await registry.register(socketB, { name: "inv", cwd: "/b", git_branch: "" });
        expect(r).toBe("ok");
        expect(registry.getName(socketB)).toBe("inv");
    });

    test("returns name_taken when existing socket replies pong to probe", async () => {
        const registry = createPeerRegistry();
        const socketA = aliveRespondingSocket(registry);
        const socketB = liveSocket();

        await registry.register(socketA, { name: "inv", cwd: "/a", git_branch: "" });

        const r = await registry.register(socketB, { name: "inv", cwd: "/b", git_branch: "" });
        expect(r).toBe("name_taken");
        expect(registry.getName(socketA)).toBe("inv");
        expect(registry.getName(socketB)).toBeUndefined();
    });

    test("evicts socket that ignores ping (timeout) and registers the new one", async () => {
        const registry = createPeerRegistry();
        // Socket "vivo" según flags pero accepta writes silenciosamente sin responder
        const silentSocketA = {
            destroyed: false,
            writable: true,
            write: () => true,
        } as unknown as net.Socket;
        const socketB = liveSocket();

        await registry.register(silentSocketA, { name: "inv", cwd: "/a", git_branch: "" });

        const r = await registry.register(socketB, { name: "inv", cwd: "/b", git_branch: "" });
        expect(r).toBe("ok");
        expect(registry.getName(socketB)).toBe("inv");
        expect(registry.getName(silentSocketA)).toBeUndefined();
    }, 2000);

    test("second concurrent register for same name returns name_taken via race protection", async () => {
        const registry = createPeerRegistry();
        const silentSocketA = {
            destroyed: false,
            writable: true,
            write: () => true,
        } as unknown as net.Socket;
        const socketB = liveSocket();
        const socketC = liveSocket();

        await registry.register(silentSocketA, { name: "inv", cwd: "/a", git_branch: "" });

        // Disparamos B y C casi simultáneos. Mientras B espera el probe (500ms timeout),
        // C llega y debe ver registerInProgress["inv"] y devolver name_taken.
        const promiseB = registry.register(socketB, { name: "inv", cwd: "/b", git_branch: "" });
        // Pequeño tick para que B llegue al await de probeAlive
        await new Promise((r) => setTimeout(r, 10));
        const promiseC = registry.register(socketC, { name: "inv", cwd: "/c", git_branch: "" });

        const [resultB, resultC] = await Promise.all([promiseB, promiseC]);
        expect(resultB).toBe("ok");
        expect(resultC).toBe("name_taken");
        expect(registry.getName(socketB)).toBe("inv");
        expect(registry.getName(socketC)).toBeUndefined();
    }, 2000);

    test("handlePong with unknown req_id is a noop (no throw)", () => {
        const registry = createPeerRegistry();
        expect(() => registry.handlePong("unknown-req-id")).not.toThrow();
    });
});

describe("rooms in registry (unit)", () => {
    const liveSocket = () => ({ destroyed: false, writable: true }) as unknown as net.Socket;

    test("joinRoom creates implicitly and returns members", () => {
        const reg = createPeerRegistry();
        expect(reg.joinRoom("alice", "diseno")).toEqual(["alice"]);
        const second = reg.joinRoom("bob", "diseno").sort();
        expect(second).toEqual(["alice", "bob"]);
    });

    test("leaveRoom of last member destroys the room", () => {
        const reg = createPeerRegistry();
        reg.joinRoom("alice", "diseno");
        expect(reg.listRooms()).toHaveLength(1);
        const removed = reg.leaveRoom("alice", "diseno");
        expect(removed).toBe(true);
        expect(reg.listRooms()).toHaveLength(0);
    });

    test("leaveRoom of non-existing room returns false (no crash)", () => {
        const reg = createPeerRegistry();
        expect(reg.leaveRoom("alice", "ghost")).toBe(false);
    });

    test("leaveRoom of peer not in room returns false but room persists", () => {
        const reg = createPeerRegistry();
        reg.joinRoom("alice", "diseno");
        expect(reg.leaveRoom("bob", "diseno")).toBe(false);
        expect(reg.listRooms()).toHaveLength(1);
        expect(reg.getRoomMembers("diseno")).toEqual(["alice"]);
    });

    test("removeBySocket cleans peer from all rooms; empty rooms destroyed", async () => {
        const reg = createPeerRegistry();
        const sa = liveSocket();
        const sb = liveSocket();
        await reg.register(sa, { name: "alice", cwd: "/a", git_branch: "" });
        await reg.register(sb, { name: "bob", cwd: "/b", git_branch: "" });
        reg.joinRoom("alice", "diseno");
        reg.joinRoom("alice", "code");
        reg.joinRoom("bob", "diseno");
        reg.removeBySocket(sa);
        const rooms = reg.listRooms();
        expect(rooms).toHaveLength(1);
        expect(rooms[0]!.name).toBe("diseno");
        expect(rooms[0]!.members).toEqual(["bob"]);
    });

    test("rename updates peer name in all rooms where it was present", async () => {
        const reg = createPeerRegistry();
        const sa = liveSocket();
        await reg.register(sa, { name: "alice", cwd: "/a", git_branch: "" });
        reg.joinRoom("alice", "diseno");
        reg.joinRoom("alice", "code");
        const result = reg.rename(sa, "alicia");
        expect(result).toBe("ok");
        expect(reg.getRoomMembers("diseno")).toEqual(["alicia"]);
        expect(reg.getRoomMembers("code")).toEqual(["alicia"]);
    });

    test("listRooms returns all rooms with members", () => {
        const reg = createPeerRegistry();
        reg.joinRoom("alice", "a");
        reg.joinRoom("bob", "a");
        reg.joinRoom("alice", "b");
        const rooms = reg.listRooms().sort((a, b) => a.name.localeCompare(b.name));
        expect(rooms).toHaveLength(2);
        expect(rooms[0]!.name).toBe("a");
        expect(rooms[0]!.members.sort()).toEqual(["alice", "bob"]);
        expect(rooms[1]!.name).toBe("b");
        expect(rooms[1]!.members).toEqual(["alice"]);
    });

    test("getRoomMembers of non-existing room returns []", () => {
        const reg = createPeerRegistry();
        expect(reg.getRoomMembers("ghost")).toEqual([]);
    });
});

describe("E2E zombie probe via real hub", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("zombie peer that ignores ping is evicted; new peer obtains the name", async () => {
        // Connect A and register as "ghost". A es un raw client que NO responde a ping.
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "ghost",
            cwd: "/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        const ackA = await a.next();
        expect(ackA.type).toBe("ack");

        // Connect B y registrar el mismo nombre. Como A no responde a ping,
        // tras 500ms el hub debe evictar A y aceptar a B.
        const b = await rawConnect(sockPath);
        b.send({
            type: "register",
            name: "ghost",
            cwd: "/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        const ackB = await b.next();
        expect(ackB.type).toBe("ack");

        // Verificar que un tercer peer ve "ghost" perteneciendo solo al socket de B.
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe",
            cwd: "/p",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await probe.next();
        probe.send({ type: "list_peers" });
        const peers = await probe.next();
        if (peers.type === "peers") {
            const names = peers.peers.map((p) => p.name).sort();
            expect(names).toEqual(["ghost"]);
        }

        a.close();
        b.close();
        probe.close();
    }, 5000);

    test("sweep evicts a peer that ignores ping after the configured interval", async () => {
        const sockPathLocal = tmpSocket();
        const hubLocal = await startHub({
            socketPath: sockPathLocal,
            sweepIntervalMs: 200,
            sweepProbeTimeoutMs: 100,
        });

        try {
            // Connect a peer that never replies pong (no auto-responder).
            const ghost = await rawConnect(sockPathLocal);
            ghost.send({
                type: "register",
                name: "ghost",
                cwd: "/g",
                git_branch: "",
                protocol_version: PROTOCOL_VERSION,
            });
            const ack = await ghost.next();
            expect(ack.type).toBe("ack");

            // Wait long enough for at least one sweep + probe timeout.
            await new Promise((r) => setTimeout(r, 500));

            // Connect a probe and verify ghost is gone.
            const probe = await rawConnect(sockPathLocal);
            probe.send({
                type: "register",
                name: "watcher",
                cwd: "/w",
                git_branch: "",
                protocol_version: PROTOCOL_VERSION,
            });
            await probe.next();
            probe.send({ type: "list_peers" });
            const peers = await probe.next();
            if (peers.type === "peers") {
                const names = peers.peers.map((p) => p.name);
                expect(names).not.toContain("ghost");
            } else {
                throw new Error(`expected peers, got ${peers.type}`);
            }

            ghost.close();
            probe.close();
        } finally {
            await hubLocal.close();
        }
    }, 5000);

    test("alive peer that auto-replies pong keeps the name (new peer gets name_taken)", async () => {
        const a = await rawConnect(sockPath);
        // Auto-responder: cuando A reciba un ping, responde con pong.
        a.socket.on("data", (chunk: Buffer) => {
            const lines = chunk
                .toString("utf8")
                .split("\n")
                .filter((l) => l.length > 0);
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line) as { type?: string; req_id?: string };
                    if (obj.type === "ping" && typeof obj.req_id === "string") {
                        a.send({ type: "pong", req_id: obj.req_id });
                    }
                } catch {}
            }
        });

        a.send({
            type: "register",
            name: "ghost-alive",
            cwd: "/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        const ackA = await a.next();
        expect(ackA.type).toBe("ack");

        const b = await rawConnect(sockPath);
        b.send({
            type: "register",
            name: "ghost-alive",
            cwd: "/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        const replyB = await b.next();
        expect(replyB.type).toBe("err");
        if (replyB.type === "err") expect(replyB.code).toBe("name_taken");

        a.close();
        b.close();
    }, 5000);
});

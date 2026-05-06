import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../protocol";
import { rawConnect, startCh, tmpSocket } from "./test-helpers";

describe("channel lifecycle", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
        sockPath = tmpSocket();
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("first channel spawns hub (host role) and registers", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        expect(ch.getHubRole()).toBe("host");
        expect(typeof ch.getName()).toBe("string");
        expect(ch.getName().length).toBeGreaterThan(0);

        // Verify self visible via an independent client -> list_peers shows self
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe",
            cwd: "/tmp/probe",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        const ack = JSON.parse(await probe.nextLine());
        expect(ack.type).toBe("ack");
        probe.send({ type: "list_peers" });
        const peers = JSON.parse(await probe.nextLine());
        expect(peers.type).toBe("peers");
        const names = peers.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(ch.getName());
        probe.close();
    });

    test("second channel connects as client; first sees it", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        expect(ch1.getHubRole()).toBe("host");

        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        expect(ch2.getHubRole()).toBe("client");

        // Probe: list_peers and verify both names
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe2",
            cwd: "/tmp/probe",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await probe.nextLine());
        probe.send({ type: "list_peers" });
        const peers = JSON.parse(await probe.nextLine());
        const names = peers.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(ch1.getName());
        expect(names).toContain(ch2.getName());
        probe.close();
    });

    test("declares claude/channel capability and instructions", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const caps = ch.getCapabilities();
        const experimental = caps.experimental as Record<string, unknown>;
        expect(experimental).toHaveProperty("claude/channel");
        const instr = ch.getInstructions();
        expect(instr).toContain("relay_reply");
        expect(instr).toContain("relay_peers");
    });

    test("instructions impose an imperative reply obligation on incoming asks", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const instr = ch.getInstructions();
        expect(instr).toContain("MUST");
        expect(instr).toContain("relay_reply");
        expect(instr).toContain("ask_id");
        expect(instr.toLowerCase()).toContain("waiting");
    });

    test("instructions tell Claude to surface question-backs in incoming replies", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const instr = ch.getInstructions();
        expect(instr).toContain("surface that question to the user");
        expect(instr).toContain("question-back");
    });

    test("instructions tell Claude to resolve pronoun peer references to the most recent target", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const instr = ch.getInstructions();
        expect(instr).toContain("carry forward the most recent");
        expect(instr).toContain("pronoun or demonstrative");
    });

    test("instructions forbid relay_broadcast as a fallback when relay_ask fails", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const instr = ch.getInstructions();
        expect(instr).toMatch(/never broadcast/i);
        expect(instr).toContain("peer_not_found");
        expect(instr).toContain("peer_gone");
        expect(instr).toContain("timeout");
        expect(instr.toLowerCase()).toContain("fallback");
    });

    test("exposes 5 tool stubs", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const tools = ch.getToolNames();
        expect(tools.sort()).toEqual(
            ["relay_ask", "relay_broadcast", "relay_peers", "relay_rename", "relay_reply"].sort(),
        );
    });

    test("MCP transport close tears down hub connection and removes peer", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());

        // Inject a fake transport so we can trigger MCP-side close deterministically.
        // server.onclose is what the SDK invokes when the real stdio transport ends
        // (parent Claude Code dies -> stdin EOF).
        let triggerTransportClose: (() => void) | undefined;
        const fakeTransport = {
            connect: async (server: Server): Promise<void> => {
                triggerTransportClose = () => server.onclose?.();
            },
        };

        const ch2 = await startCh({ socketPath: sockPath, transport: fakeTransport });
        closers.push(() => ch2.close());

        // Probe hub to confirm ch2 is registered.
        const probe = await rawConnect(sockPath);
        closers.push(async () => probe.close());
        probe.send({
            type: "register",
            name: "close-probe",
            cwd: "/tmp/probe",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await probe.nextLine());
        probe.send({ type: "list_peers" });
        const before = JSON.parse(await probe.nextLine());
        const namesBefore = before.peers.map((p: { name: string }) => p.name);
        expect(namesBefore).toContain(ch2.getName());

        // Simulate parent Claude dying: MCP transport closes.
        expect(triggerTransportClose).toBeDefined();
        triggerTransportClose!();

        // Give the hub a moment to observe the hub-socket close and reap the peer.
        await new Promise((r) => setTimeout(r, 50));

        probe.send({ type: "list_peers" });
        const after = JSON.parse(await probe.nextLine());
        const namesAfter = after.peers.map((p: { name: string }) => p.name);
        expect(namesAfter).not.toContain(ch2.getName());
    });
});

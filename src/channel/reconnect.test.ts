import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startHub, type HubHandle } from "../hub/index";
import { startCh, tmpSocket, type ChannelH } from "./test-helpers";

async function waitForReconnect(ch: ChannelH, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let result = await ch.callTool("relay_peers", {});
    while (result.isError && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        result = await ch.callTool("relay_peers", {});
    }
    return result;
}

describe("channel auto-reconnect", () => {
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

    test("channel reconnects to a fresh hub after the original dies", async () => {
        const hub1: HubHandle = await startHub({ socketPath: sockPath });

        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());

        const pre = await ch.callTool("relay_peers", {});
        expect(pre.isError).toBeFalsy();

        await hub1.close();

        const hub2 = await startHub({ socketPath: sockPath });
        closers.push(() => hub2.close());

        const post = await waitForReconnect(ch);
        expect(post.isError).toBeFalsy();
        const payload = JSON.parse(post.content[0]!.text);
        expect(payload.me).toBe(ch.getName());
        expect(Array.isArray(payload.peers)).toBe(true);
    });

    test("in-flight ask on hub disconnect: no error notification fires; subsequent ask works", async () => {
        const hub1: HubHandle = await startHub({ socketPath: sockPath });

        const notifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch = await startCh({
            socketPath: sockPath,
            onNotification: (n) => notifs.push(n),
        });
        closers.push(() => ch.close());

        // Fire an ask that will never be answered; hub dies mid-flight.
        const res = await ch.callTool("relay_ask", {
            to: "never-replies",
            question: "?",
        });
        const askId = JSON.parse(res.content[0]!.text).ask_id as string;
        // Immediately (before hub had a chance to error peer_not_found) kill the hub.
        // peer_not_found may arrive as notification; allowed but unrelated.

        await hub1.close();
        const hub2 = await startHub({ socketPath: sockPath });
        closers.push(() => hub2.close());

        const post = await waitForReconnect(ch);
        expect(post.isError).toBeFalsy();

        // No stale "hub_unreachable" error notification for the original askId
        // should be emitted by the channel — the caller's deadline is not the
        // channel's responsibility anymore.
        const stale = notifs.find((n) => {
            const m = n.params.meta as Record<string, unknown>;
            return m.ask_id === askId && m.code === "hub_unreachable";
        });
        expect(stale).toBeUndefined();

        // A subsequent ask on the reconnected channel still succeeds.
        const next = await ch.callTool("relay_ask", { to: "nobody-2", question: "?" });
        expect(next.isError).toBeFalsy();
        const nextPayload = JSON.parse(next.content[0]!.text);
        expect(nextPayload.ok).toBe(true);
        expect(typeof nextPayload.ask_id).toBe("string");
    });

    test("rename survives hub restart", async () => {
        const hub1: HubHandle = await startHub({ socketPath: sockPath });

        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());

        const renamed = await ch.callTool("relay_rename", { new_name: "bespoke-name" });
        expect(renamed.isError).toBeFalsy();
        expect(ch.getName()).toBe("bespoke-name");

        await hub1.close();

        const hub2 = await startHub({ socketPath: sockPath });
        closers.push(() => hub2.close());

        const post = await waitForReconnect(ch);
        expect(post.isError).toBeFalsy();
        expect(ch.getName()).toBe("bespoke-name");
        const payload = JSON.parse(post.content[0]!.text);
        expect(payload.me).toBe("bespoke-name");
    });
});

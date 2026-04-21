import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { startCh, tmpSocket } from "./test-helpers";

describe("channel hub connection", () => {
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

    test("relay_peers times out cleanly when hub never replies", async () => {
        // Start a silent server that accepts connections but never responds.
        const silentServer = net.createServer(() => {});
        await new Promise<void>((resolve) => silentServer.listen(sockPath, resolve));
        closers.push(
            () =>
                new Promise<void>((resolve) => {
                    silentServer.close(() => resolve());
                }),
        );
        const ch = await startCh({
            socketPath: sockPath,
            requestTimeoutMs: 50,
            skipRegister: true,
        });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_peers", {});
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "hub_unreachable" });
    });

    test("relay_broadcast times out cleanly when hub never acks", async () => {
        const silentServer = net.createServer(() => {});
        await new Promise<void>((resolve) => silentServer.listen(sockPath, resolve));
        closers.push(
            () =>
                new Promise<void>((resolve) => {
                    silentServer.close(() => resolve());
                }),
        );
        const ch = await startCh({
            socketPath: sockPath,
            broadcastTimeoutMs: 50,
            skipRegister: true,
        });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_broadcast", { question: "?" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "hub_unreachable" });
    });
});

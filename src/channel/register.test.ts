import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startHub } from "../hub/index";
import { PROTOCOL_VERSION } from "../protocol";
import { rawConnect, startCh, tmpSocket } from "./test-helpers";

describe("channel register", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];
    const originalRelayPeerId = process.env.RELAY_PEER_ID;

    beforeEach(() => {
        sockPath = tmpSocket();
        // Ensure determinism: the channel should fall back to defaultName(cwd)
        // for these tests, regardless of how the test runner was launched.
        delete process.env.RELAY_PEER_ID;
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
        if (originalRelayPeerId === undefined) {
            delete process.env.RELAY_PEER_ID;
        } else {
            process.env.RELAY_PEER_ID = originalRelayPeerId;
        }
    });

    test("name_taken retry: appends -N suffix", async () => {
        const hub = await startHub({ socketPath: sockPath });
        closers.push(() => hub.close());

        // Pre-register the name that the channel would pick by default
        // We need to know what defaultName returns; reuse it
        const { defaultName } = await import("../identity");
        const taken = defaultName(process.cwd());

        const squatter = await rawConnect(sockPath);
        // Auto-respond to hub probe pings so the squatter is treated as a live peer
        // (mirrors what a real channel does in routing.ts).
        squatter.socket.on("data", (chunk: Buffer) => {
            const lines = chunk
                .toString("utf8")
                .split("\n")
                .filter((l) => l.length > 0);
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line) as { type?: string; req_id?: string };
                    if (obj.type === "ping" && typeof obj.req_id === "string") {
                        squatter.send({ type: "pong", req_id: obj.req_id });
                    }
                } catch {}
            }
        });
        squatter.send({
            type: "register",
            name: taken,
            cwd: "/tmp",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await squatter.nextLine());

        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        expect(ch.getHubRole()).toBe("client");
        expect(ch.getName()).toBe(`${taken}-2`);
        squatter.close();
    });

    test("protocol_mismatch err throws with instruction to kill the hub", async () => {
        // Spin up a mini "fake hub": a Unix socket server that always replies
        // with protocol_mismatch on register. This simulates a stale hub left
        // over after the client upgraded to a newer protocol_version.
        const net = await import("node:net");
        const { readLines } = await import("../framing");
        const sPath = tmpSocket();
        const fakeHub = net.createServer((s) => {
            readLines(s, () => {
                s.write(JSON.stringify({ type: "err", code: "protocol_mismatch" }) + "\n");
            });
        });
        await new Promise<void>((r) => fakeHub.listen(sPath, () => r()));
        closers.push(
            () =>
                new Promise<void>((r) => {
                    fakeHub.close(() => r());
                }),
        );

        const socket = net.createConnection(sPath);
        await new Promise<void>((r) => socket.on("connect", () => r()));
        const { createHubConnection } = await import("./hub-connection");
        const conn = createHubConnection(socket);

        const { registerWithRetries } = await import("./register");
        let caught: unknown;
        try {
            await registerWithRetries(conn, { cwd: "/tmp", git_branch: "" }, "some-name");
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const msg = caught instanceof Error ? caught.message : "";
        expect(msg).toContain("protocol_mismatch");
        expect(msg).toContain("pkill -f hub-daemon.ts");
        conn.close();
    });
});

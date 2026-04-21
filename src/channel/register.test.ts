import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startHub } from "../hub/index";
import { PROTOCOL_VERSION } from "../protocol";
import { rawConnect, startCh, tmpSocket } from "./test-helpers";

describe("channel register", () => {
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

    test("name_taken retry: appends -N suffix", async () => {
        const hub = await startHub({ socketPath: sockPath });
        closers.push(() => hub.close());

        // Pre-register the name that the channel would pick by default
        // We need to know what defaultName returns; reuse it
        const { defaultName } = await import("../identity");
        const taken = defaultName(process.cwd());

        const squatter = await rawConnect(sockPath);
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

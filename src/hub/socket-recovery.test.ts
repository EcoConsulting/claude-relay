import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { PROTOCOL_VERSION } from "../protocol";
import { startHub } from "./index";
import { rawConnect, tmpSocket } from "./test-helpers";

describe("hub socket recovery", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("stale socket file is unlinked and hub starts", async () => {
        const p = tmpSocket();
        fs.writeFileSync(p, "");
        const h = await startHub({ socketPath: p });
        const c = await rawConnect(p);
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
        await h.close();
    });

    test("live socket on same path causes startHub to throw", async () => {
        const p = tmpSocket();
        const h1 = await startHub({ socketPath: p });
        let threw = false;
        try {
            await startHub({ socketPath: p });
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
        await h1.close();
    });
});

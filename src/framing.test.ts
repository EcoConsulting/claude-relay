import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "./framing";

describe("framing", () => {
    let server: net.Server;
    let sockPath: string;

    beforeEach(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-framing-"));
        sockPath = path.join(dir, "s.sock");
        server = net.createServer();
        await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
            fs.unlinkSync(sockPath);
        } catch {}
    });

    function connectPair(
        onLine: (line: string) => void,
    ): Promise<{ client: net.Socket; server: net.Socket }> {
        return new Promise((resolve) => {
            const acceptPromise = new Promise<net.Socket>((accept) => {
                server.once("connection", (s) => accept(s));
            });
            const client = net.createConnection(sockPath, async () => {
                const serverSocket = await acceptPromise;
                readLines(serverSocket, onLine);
                resolve({ client, server: serverSocket });
            });
        });
    }

    test("delivers a line just under the cap", async () => {
        const lines: string[] = [];
        const { client, server: srv } = await connectPair((line) => lines.push(line));

        const payload = "B".repeat(64 * 1024 - 1);
        client.write(payload + "\n");

        // Wait for the line to surface.
        await new Promise<void>((resolve) => {
            const iv = setInterval(() => {
                if (lines.length > 0) {
                    clearInterval(iv);
                    resolve();
                }
            }, 5);
        });

        expect(lines).toEqual([payload]);
        expect(srv.destroyed).toBe(false);
        client.destroy();
    });

    test("destroys socket when line exceeds 64KB without newline", async () => {
        const lines: string[] = [];
        const { client, server: srv } = await connectPair((line) => lines.push(line));

        const destroyed = new Promise<void>((resolve) => {
            srv.on("close", () => resolve());
        });

        // Send 1MB without a newline.
        const chunk = Buffer.alloc(64 * 1024, 0x41); // "A"
        for (let i = 0; i < 16; i++) {
            client.write(chunk);
        }

        await destroyed;
        expect(srv.destroyed).toBe(true);
        expect(lines).toEqual([]);
        client.destroy();
    });
});

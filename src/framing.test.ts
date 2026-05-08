import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_LINE_LEN, readLines, writeLine } from "./framing";

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

        const payload = "B".repeat(MAX_LINE_LEN - 1);
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

    test("delivers a 200KB line through the framing layer", async () => {
        const lines: string[] = [];
        const { client, server: srv } = await connectPair((line) => lines.push(line));

        const payload = "X".repeat(200 * 1024);
        client.write(payload + "\n");

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

    test("writeLine drops oversize outbound lines without writing", () => {
        const writes: string[] = [];
        const fakeSocket = {
            write: (chunk: string) => {
                writes.push(chunk);
                return true;
            },
        } as unknown as net.Socket;

        // Build an object whose JSON.stringify(...) + "\n" exceeds MAX_LINE_LEN.
        const oversize = { type: "ask", question: "Q".repeat(MAX_LINE_LEN + 1) };
        writeLine(fakeSocket, oversize);

        expect(writes).toEqual([]);
    });

    test("writeLine writes lines at or under MAX_LINE_LEN", () => {
        const writes: string[] = [];
        const fakeSocket = {
            write: (chunk: string) => {
                writes.push(chunk);
                return true;
            },
        } as unknown as net.Socket;

        writeLine(fakeSocket, { type: "ack" });
        expect(writes.length).toBe(1);
        expect(writes[0]).toBe('{"type":"ack"}\n');
    });

    test("destroys socket when line exceeds MAX_LINE_LEN without newline", async () => {
        const lines: string[] = [];
        const { client, server: srv } = await connectPair((line) => lines.push(line));

        const destroyed = new Promise<void>((resolve) => {
            srv.on("close", () => resolve());
        });

        const chunkSize = 64 * 1024;
        const chunk = Buffer.alloc(chunkSize, 0x41);
        const chunks = Math.ceil((MAX_LINE_LEN * 2) / chunkSize);
        for (let i = 0; i < chunks; i++) {
            client.write(chunk);
        }

        await destroyed;
        expect(srv.destroyed).toBe(true);
        expect(lines).toEqual([]);
        client.destroy();
    });
});

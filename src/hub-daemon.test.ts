import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { startChannel } from "./channel";
import { PROTOCOL_VERSION } from "./protocol";

const DAEMON_ENTRY = path.resolve(import.meta.dir, "hub-daemon.ts");

function tmpSocket(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-daemon-test-"));
    return path.join(dir, "hub.sock");
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(socketPath)) {
            const ok = await new Promise<boolean>((resolve) => {
                const probe = net.createConnection(socketPath);
                probe.once("connect", () => {
                    probe.destroy();
                    resolve(true);
                });
                probe.once("error", () => resolve(false));
            });
            if (ok) return;
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`socket did not appear at ${socketPath} within ${timeoutMs}ms`);
}

function rawRegister(
    sockPath: string,
    name: string,
): Promise<{ ack: unknown; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(sockPath);
        let buf = "";
        socket.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const idx = buf.indexOf("\n");
            if (idx >= 0) {
                const line = buf.slice(0, idx);
                resolve({ ack: JSON.parse(line), socket });
            }
        });
        socket.once("error", reject);
        socket.once("connect", () => {
            socket.write(
                JSON.stringify({
                    type: "register",
                    name,
                    cwd: "/tmp",
                    git_branch: "",
                    protocol_version: PROTOCOL_VERSION,
                }) + "\n",
            );
        });
    });
}

describe("hub-daemon", () => {
    const cleanup: Array<() => void | Promise<void>> = [];

    afterEach(async () => {
        while (cleanup.length) {
            const c = cleanup.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("runs as standalone bun process, serves hub protocol", async () => {
        const sockPath = tmpSocket();
        const child = spawn("bun", ["run", DAEMON_ENTRY], {
            env: { ...process.env, RELAY_HUB_SOCKET: sockPath },
            stdio: ["ignore", "ignore", "ignore"],
        });
        cleanup.push(() => {
            try {
                child.kill("SIGKILL");
            } catch {}
        });
        await waitForSocket(sockPath, 5000);
        const { ack, socket } = await rawRegister(sockPath, "daemon-probe");
        cleanup.push(() => {
            socket.destroy();
        });
        expect((ack as { type: string }).type).toBe("ack");
    });

    test("default spawner starts detached daemon that survives channel close", async () => {
        const sockPath = tmpSocket();
        const ch = await startChannel({ socketPath: sockPath });
        expect(ch.getHubRole()).toBe("host");

        // Close the channel (simulates host session ending).
        await ch.close();

        // If the hub ran in-process with the channel, the socket would now be gone.
        // With a detached daemon, the socket is still there and serves requests.
        const { ack, socket } = await rawRegister(sockPath, "post-close-probe");
        cleanup.push(() => {
            socket.destroy();
        });
        expect((ack as { type: string }).type).toBe("ack");

        // Unlink the socket so a stale file doesn't confuse other tests.
        // The detached daemon has no live clients and will idle-exit on its own;
        // we deliberately don't pgrep + kill here because that would match any
        // hub-daemon.ts process on the system, including production daemons.
        cleanup.push(() => {
            try {
                fs.unlinkSync(sockPath);
            } catch {}
        });
    });
});

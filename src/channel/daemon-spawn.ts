import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const DAEMON_ENTRY = path.resolve(import.meta.dir, "..", "hub-daemon.ts");

export function tryConnect(socketPath: string): Promise<net.Socket | null> {
    const sock = new net.Socket();
    sock.on("error", () => {});
    return new Promise((resolve) => {
        const onConnect = () => {
            sock.removeListener("error", onError);
            sock.on("error", () => {});
            resolve(sock);
        };
        const onError = () => {
            sock.removeListener("connect", onConnect);
            try {
                sock.destroy();
            } catch {}
            resolve(null);
        };
        sock.once("connect", onConnect);
        sock.once("error", onError);
        sock.connect(socketPath);
    });
}

export async function waitForSocketReady(
    socketPath: string,
    timeoutMs: number,
): Promise<net.Socket | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(socketPath)) {
            const sock = await tryConnect(socketPath);
            if (sock) return sock;
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    return null;
}

export async function spawnDetachedDaemon(
    socketPath: string,
): Promise<{ close: () => Promise<void> }> {
    const env = Object.fromEntries(
        Object.entries({
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            TMPDIR: process.env.TMPDIR,
            RELAY_HUB_SOCKET: socketPath,
            CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
        }).filter(([, v]) => v !== undefined),
    );
    if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", "start", '""', "/b", "bun", "run", DAEMON_ENTRY], {
            env,
            stdio: "ignore",
            detached: true,
            cwd: path.dirname(DAEMON_ENTRY),
        }).unref();
    } else {
        const child = spawn("bun", ["run", DAEMON_ENTRY], {
            env,
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
        });
        child.unref();
    }
    return {
        close: async () => {
            // Daemon is independent; do not kill on channel close.
        },
    };
}

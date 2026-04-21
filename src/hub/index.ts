import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { readLines, writeLine } from "../framing";
import { makeLogger } from "../logger";
import { ClientMsgSchema, type ServerMsg } from "../protocol";
import {
    handleAsk,
    handleBroadcast,
    handleListPeers,
    handleRegister,
    handleRename,
    handleReply,
    type HubContext,
} from "./handlers";
import { createPendingAsks, type PendingAsk } from "./pending-asks";
import { createPeerRegistry } from "./registry";
import { listenWithRecovery } from "./socket-recovery";

const log = makeLogger("hub");

export type { PendingAsk } from "./pending-asks";

export type StartHubOptions = {
    socketPath: string;
    defaultAskTimeoutMs?: number;
    pendingAsks?: Map<string, PendingAsk>;
    idleExitMs?: number;
    onIdleExit?: () => void;
};

export type HubHandle = { close: () => Promise<void> };

export async function startHub(opts: StartHubOptions): Promise<HubHandle> {
    const { socketPath } = opts;
    const defaultAskTimeoutMs = opts.defaultAskTimeoutMs ?? 120_000;
    const idleExitMs = opts.idleExitMs ?? 5 * 60 * 1000;
    const onIdleExit = opts.onIdleExit ?? (() => process.exit(0));

    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const registry = createPeerRegistry();
    const pendingAsks = createPendingAsks(opts.pendingAsks);

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelIdleTimer = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    };
    const cancelIdleTimerLogged = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
            log.debug("idle_exit_cancelled");
        }
    };
    const scheduleIdleTimerIfEmpty = () => {
        if (registry.isEmpty() && !idleTimer) {
            log.debug("idle_exit_scheduled", { ms: idleExitMs });
            idleTimer = setTimeout(() => {
                idleTimer = null;
                log.info("idle_exit_fired");
                onIdleExit();
            }, idleExitMs);
        }
    };

    const sendTo = (name: string, msg: ServerMsg): boolean => {
        const s = registry.getSocket(name);
        if (!s) return false;
        try {
            writeLine(s, msg);
            return true;
        } catch {
            return false;
        }
    };

    const ctx: HubContext = { registry, pendingAsks, defaultAskTimeoutMs, sendTo };

    const handleLine = (line: string, socket: net.Socket, send: (msg: ServerMsg) => void) => {
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch (e) {
            log.warn("bad_msg", {
                err: e instanceof Error ? e.message : String(e),
                raw_sample: line.slice(0, 200),
            });
            send({ type: "err", code: "bad_msg" });
            return;
        }
        const parsed = ClientMsgSchema.safeParse(raw);
        if (!parsed.success) {
            log.warn("bad_msg", {
                err: parsed.error.message,
                raw_sample: line.slice(0, 200),
            });
            send({ type: "err", code: "bad_msg" });
            return;
        }
        const msg = parsed.data;
        ctx.registry.touch(socket);
        switch (msg.type) {
            case "register":
                return handleRegister(ctx, socket, msg, send);
            case "rename":
                return handleRename(ctx, socket, msg, send);
            case "list_peers":
                return handleListPeers(ctx, socket, msg, send);
            case "ask":
                return handleAsk(ctx, socket, msg, send);
            case "reply":
                return handleReply(ctx, socket, msg, send);
            case "broadcast":
                return handleBroadcast(ctx, socket, msg, send);
        }
    };

    const server = net.createServer((socket) => {
        log.debug("peer_connect");
        if (idleTimer) cancelIdleTimerLogged();
        else cancelIdleTimer();

        const send = (msg: ServerMsg) => {
            writeLine(socket, msg);
        };

        readLines(socket, (line) => handleLine(line, socket, send));

        socket.on("close", () => {
            const name = registry.removeBySocket(socket);
            if (name) {
                const { peerGone } = pendingAsks.cleanupForDisconnect(name);
                for (const { askId, caller } of peerGone) {
                    sendTo(caller, { type: "err", code: "peer_gone", ask_id: askId });
                }
            }
            scheduleIdleTimerIfEmpty();
        });

        socket.on("error", () => {});
    });

    await listenWithRecovery(server, socketPath);
    fs.chmodSync(socketPath, 0o600);
    log.info("listen_start", { socketPath });
    scheduleIdleTimerIfEmpty();

    return {
        close: () =>
            new Promise<void>((resolve) => {
                cancelIdleTimer();
                pendingAsks.clearAll();
                server.close(() => {
                    try {
                        fs.unlinkSync(socketPath);
                    } catch {}
                    resolve();
                });
                for (const s of registry.sockets()) {
                    try {
                        s.destroy();
                    } catch {}
                }
            }),
    };
}

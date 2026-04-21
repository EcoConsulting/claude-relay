import type * as net from "node:net";
import { makeLogger } from "../logger";
import type { PeerRecord } from "../protocol";

const log = makeLogger("hub");

export type PeerEntry = {
    name: string;
    cwd: string;
    git_branch: string;
    last_seen: number;
};

export type RegisterInput = {
    name: string;
    cwd: string;
    git_branch: string;
};

export type RegisterResult = "ok" | "name_taken" | "already_registered";
export type RenameResult = "ok" | "name_taken" | "not_registered" | "noop";

export type PeerRegistry = ReturnType<typeof createPeerRegistry>;

export function createPeerRegistry() {
    const peers = new Map<string, PeerEntry>();
    const nameToSocket = new Map<string, net.Socket>();
    const socketToName = new Map<net.Socket, string>();

    function register(socket: net.Socket, msg: RegisterInput): RegisterResult {
        if (socketToName.has(socket)) {
            log.warn("peer_register_err", { code: "already_registered", attempted_name: msg.name });
            return "already_registered";
        }
        const existing = nameToSocket.get(msg.name);
        if (existing && existing !== socket) {
            log.warn("peer_register_err", { code: "name_taken", attempted_name: msg.name });
            return "name_taken";
        }
        peers.set(msg.name, {
            name: msg.name,
            cwd: msg.cwd,
            git_branch: msg.git_branch,
            last_seen: Date.now(),
        });
        socketToName.set(socket, msg.name);
        nameToSocket.set(msg.name, socket);
        log.info("peer_register", {
            name: msg.name,
            cwd: msg.cwd,
            git_branch: msg.git_branch,
        });
        return "ok";
    }

    function rename(socket: net.Socket, newName: string): RenameResult {
        const current = socketToName.get(socket);
        if (!current) {
            log.warn("peer_rename_err", { code: "not_registered" });
            return "not_registered";
        }
        if (newName === current) return "noop";
        if (peers.has(newName) || nameToSocket.has(newName)) {
            log.warn("peer_rename_err", { code: "name_taken" });
            return "name_taken";
        }
        const entry = peers.get(current);
        if (entry) {
            peers.delete(current);
            peers.set(newName, { ...entry, name: newName });
        }
        nameToSocket.delete(current);
        nameToSocket.set(newName, socket);
        socketToName.set(socket, newName);
        log.info("peer_rename", { from: current, to: newName });
        return "ok";
    }

    function touch(socket: net.Socket): void {
        const name = socketToName.get(socket);
        if (!name) return;
        const entry = peers.get(name);
        if (!entry) return;
        entry.last_seen = Date.now();
    }

    function removeBySocket(socket: net.Socket): string | undefined {
        const name = socketToName.get(socket);
        if (!name) return undefined;
        log.info("peer_disconnect", { name });
        socketToName.delete(socket);
        if (nameToSocket.get(name) === socket) {
            nameToSocket.delete(name);
        }
        peers.delete(name);
        return name;
    }

    function list(exceptName?: string): PeerRecord[] {
        const out: PeerRecord[] = [];
        for (const p of peers.values()) {
            if (p.name === exceptName) continue;
            out.push({
                name: p.name,
                cwd: p.cwd,
                git_branch: p.git_branch,
                last_seen: p.last_seen,
            });
        }
        return out;
    }

    return {
        register,
        rename,
        touch,
        removeBySocket,
        list,
        getSocket: (name: string) => nameToSocket.get(name),
        getName: (socket: net.Socket) => socketToName.get(socket),
        hasName: (name: string) => nameToSocket.has(name),
        isEmpty: () => peers.size === 0 && nameToSocket.size === 0,
        names: () => nameToSocket.keys(),
        sockets: () => socketToName.keys(),
    };
}

import type * as net from "node:net";
import { startHub } from "../hub/index";
import { rawConnectLines, tmpSocket as sharedTmpSocket } from "../test-helpers";
import { startChannel, type StartChannelOptions } from "./index";

// Tests inject an in-process hub via hubSpawner so they don't shell out to
// `bun run hub-daemon.ts` (which is the production default).
const inProcessSpawner: NonNullable<StartChannelOptions["hubSpawner"]> = (p) =>
    startHub({ socketPath: p });

export type ChannelH = Awaited<ReturnType<typeof startChannel>>;

export const startCh = (opts: StartChannelOptions = {}): Promise<ChannelH> =>
    startChannel({ hubSpawner: inProcessSpawner, ...opts });

export function tmpSocket(): string {
    return sharedTmpSocket("relay-chan-test-");
}

export type SimpleClient = {
    socket: net.Socket;
    send: (obj: unknown) => void;
    nextLine: () => Promise<string>;
    close: () => void;
};

export async function rawConnect(sockPath: string): Promise<SimpleClient> {
    const c = await rawConnectLines(sockPath);
    return {
        socket: c.socket,
        send: c.send,
        nextLine: c.next,
        close: c.close,
    };
}

export async function waitForNotif<T>(arr: T[], n: number, tries = 200): Promise<void> {
    for (let i = 0; i < tries; i++) {
        if (arr.length >= n) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`expected ${n} notifications, got ${arr.length}`);
}

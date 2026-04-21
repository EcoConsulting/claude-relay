import type * as net from "node:net";
import type { ServerMsg } from "../protocol";
import { rawConnectParsed, tmpSocket as sharedTmpSocket } from "../test-helpers";

export function tmpSocket(): string {
    return sharedTmpSocket("relay-test-");
}

export type Client = {
    socket: net.Socket;
    send: (obj: unknown) => void;
    next: () => Promise<ServerMsg>;
    close: () => void;
};

export function rawConnect(sockPath: string): Promise<Client> {
    return rawConnectParsed<ServerMsg>(sockPath);
}

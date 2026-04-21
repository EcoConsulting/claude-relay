import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "./framing";

export function tmpSocket(prefix = "relay-test-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return path.join(dir, "hub.sock");
}

type RawClient<T> = {
    socket: net.Socket;
    send: (obj: unknown) => void;
    next: () => Promise<T>;
    close: () => void;
};

function connectWithParser<T>(sockPath: string, parse: (line: string) => T): Promise<RawClient<T>> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(sockPath);
        const queue: T[] = [];
        const waiters: ((m: T) => void)[] = [];

        readLines(socket, (line) => {
            const m = parse(line);
            const w = waiters.shift();
            if (w) w(m);
            else queue.push(m);
        });
        socket.on("error", reject);
        socket.on("connect", () => {
            resolve({
                socket,
                send: (obj) => socket.write(JSON.stringify(obj) + "\n"),
                next: () =>
                    new Promise<T>((res) => {
                        const m = queue.shift();
                        if (m !== undefined) res(m);
                        else waiters.push(res);
                    }),
                close: () => socket.end(),
            });
        });
    });
}

export function rawConnectParsed<T = unknown>(sockPath: string): Promise<RawClient<T>> {
    return connectWithParser(sockPath, (line) => JSON.parse(line) as T);
}

export function rawConnectLines(sockPath: string): Promise<RawClient<string>> {
    return connectWithParser(sockPath, (line) => line);
}

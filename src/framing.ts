import type * as net from "node:net";
import { makeLogger } from "./logger";

const log = makeLogger("framing");

const MAX_LINE_LEN = 64 * 1024;

export function readLines(socket: net.Socket, onLine: (line: string) => void): void {
    let buffer = "";
    socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            onLine(line);
        }
        if (buffer.length > MAX_LINE_LEN) {
            log.warn("line_too_long", { bytes: buffer.length, max: MAX_LINE_LEN });
            buffer = "";
            socket.destroy();
        }
    });
}

export function writeLine(socket: net.Socket, obj: unknown): void {
    socket.write(JSON.stringify(obj) + "\n");
}

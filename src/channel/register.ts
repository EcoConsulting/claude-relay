import { makeLogger } from "../logger";
import { PROTOCOL_VERSION } from "../protocol";
import type { HubConnection } from "./hub-connection";

const log = makeLogger("channel");

export async function registerWithRetries(
    hub: HubConnection,
    base: { cwd: string; git_branch: string },
    candidate: string,
): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const name = attempt === 0 ? candidate : `${candidate}-${attempt + 1}`;
        log.debug("register_attempt", { name });
        hub.send({
            type: "register",
            name,
            cwd: base.cwd,
            git_branch: base.git_branch,
            protocol_version: PROTOCOL_VERSION,
        });
        const reply = await hub.nextMessage((m) => m.type === "ack" || m.type === "err");
        if (reply.type === "ack") {
            log.info("register_ack", { name });
            return name;
        }
        if (reply.type === "err" && reply.code === "protocol_mismatch") {
            throw new Error(
                "protocol_mismatch: hub is on a different relay version. Run `pkill -f hub-daemon.ts` to kill the stale hub; the next channel will spawn a fresh one on the current protocol version.",
            );
        }
        if (reply.type === "err" && reply.code !== "name_taken") {
            throw new Error(`register failed: ${reply.code}`);
        }
        log.warn("register_name_taken_retry", { attempted: name });
    }
    throw new Error(`register failed: exhausted name retries for ${candidate}`);
}

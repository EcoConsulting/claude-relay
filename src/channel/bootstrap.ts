import { makeLogger } from "../logger";
import { spawnDetachedDaemon, tryConnect, waitForSocketReady } from "./daemon-spawn";
import { createHubConnection, type HubConnection } from "./hub-connection";

const log = makeLogger("channel");

export type HubRole = "host" | "client";

export type HubSpawner = (socketPath: string) => Promise<{ close: () => Promise<void> }>;

export type HubBootstrap = {
    hub: HubConnection;
    hubRole: HubRole;
    hubHandle: { close: () => Promise<void> } | null;
};

export async function bootstrapHub(
    socketPath: string,
    hubSpawner: HubSpawner = spawnDetachedDaemon,
): Promise<HubBootstrap> {
    const existing = await tryConnect(socketPath);
    if (existing) {
        const hub = createHubConnection(existing);
        log.debug("hub_connect");
        return { hub, hubRole: "client", hubHandle: null };
    }

    log.info("hub_spawn");
    const hubHandle = await hubSpawner(socketPath);
    const sock = await waitForSocketReady(socketPath, process.platform === "win32" ? 5000 : 2000);
    if (!sock) {
        await hubHandle.close();
        throw new Error(`failed to connect to hub at ${socketPath} after spawn`);
    }
    const hub = createHubConnection(sock);
    log.debug("hub_connect");
    return { hub, hubRole: "host", hubHandle };
}

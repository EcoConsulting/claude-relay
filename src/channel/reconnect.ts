import { makeLogger } from "../logger";
import { bootstrapHub, type HubBootstrap, type HubSpawner } from "./bootstrap";
import type { HubConnection } from "./hub-connection";
import { registerWithRetries } from "./register";

const log = makeLogger("channel");

const RECONNECT_DELAYS_MS = [0, 100, 500, 1500, 5000] as const;
const MAX_RECONNECT_DELAY_MS = 10_000;

export type ReconnectorOptions = {
    socketPath: string;
    hubSpawner?: HubSpawner;
    getCwd: () => string;
    getGitBranch: () => string;
    skipRegister?: boolean;
    getName: () => string;
    setName: (name: string) => void;
    onReconnect: (next: HubBootstrap) => void;
};

export type Reconnector = ReturnType<typeof createReconnector>;

function delayFor(attempt: number): number {
    return RECONNECT_DELAYS_MS[attempt] ?? MAX_RECONNECT_DELAY_MS;
}

export function createReconnector(opts: ReconnectorOptions) {
    let closed = false;
    let reconnecting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function abort(next: HubBootstrap): Promise<void> {
        next.hub.close();
        if (next.hubHandle) {
            try {
                await next.hubHandle.close();
            } catch (e) {
                log.warn("abort_hub_handle_close_failed", {
                    err: e instanceof Error ? e.message : String(e),
                });
            }
        }
    }

    const scheduleReconnect = (): void => {
        if (closed || reconnecting) return;
        reconnecting = true;
        let attempt = 0;

        const tryOnce = async (): Promise<void> => {
            if (closed) {
                reconnecting = false;
                return;
            }
            try {
                const next = await bootstrapHub(opts.socketPath, opts.hubSpawner);
                if (closed) {
                    await abort(next);
                    reconnecting = false;
                    return;
                }
                const currentName = opts.getName();
                const newName = opts.skipRegister
                    ? currentName
                    : await registerWithRetries(
                          next.hub,
                          { cwd: opts.getCwd(), git_branch: opts.getGitBranch() },
                          currentName,
                      );
                if (closed) {
                    await abort(next);
                    reconnecting = false;
                    return;
                }
                if (newName !== currentName) {
                    log.warn("channel_reregistered", { from: currentName, to: newName });
                    opts.setName(newName);
                }
                opts.onReconnect(next);
                log.info("channel_reconnected", { hubRole: next.hubRole, name: opts.getName() });
                reconnecting = false;
            } catch (e) {
                attempt += 1;
                log.warn("reconnect_attempt_failed", {
                    attempt,
                    err: e instanceof Error ? e.message : String(e),
                });
                timer = setTimeout(() => {
                    timer = null;
                    void tryOnce();
                }, delayFor(attempt));
            }
        };

        timer = setTimeout(() => {
            timer = null;
            void tryOnce();
        }, delayFor(0));
    };

    return {
        wire(hub: HubConnection): void {
            hub.onDisconnect(() => {
                if (closed) return;
                scheduleReconnect();
            });
        },
        close(): void {
            closed = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}

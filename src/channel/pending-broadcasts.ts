import type { ErrCode } from "../protocol";

export type BroadcastAckResult =
    | { ok: true; broadcast_id: string; peer_count: number }
    | { ok: false; code: ErrCode };

type PendingBroadcast = {
    resolve: (result: BroadcastAckResult) => void;
    timer: ReturnType<typeof setTimeout>;
};

export type PendingBroadcasts = ReturnType<typeof createPendingBroadcasts>;

export function createPendingBroadcasts() {
    const pending = new Map<string, PendingBroadcast>();

    function create(broadcastId: string, timeoutMs: number): Promise<BroadcastAckResult> {
        return new Promise<BroadcastAckResult>((resolve) => {
            const timer = setTimeout(() => {
                if (pending.delete(broadcastId)) {
                    resolve({ ok: false, code: "hub_unreachable" });
                }
            }, timeoutMs);
            pending.set(broadcastId, { resolve, timer });
        });
    }

    function resolveWithAck(broadcastId: string, peerCount: number): void {
        const p = pending.get(broadcastId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(broadcastId);
        p.resolve({ ok: true, broadcast_id: broadcastId, peer_count: peerCount });
    }

    function resolveWithErr(broadcastId: string, code: ErrCode): void {
        const p = pending.get(broadcastId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(broadcastId);
        p.resolve({ ok: false, code });
    }

    function clear(): void {
        for (const p of pending.values()) clearTimeout(p.timer);
        pending.clear();
    }

    function failAll(code: ErrCode): void {
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.resolve({ ok: false, code });
        }
        pending.clear();
    }

    return {
        create,
        resolveWithAck,
        resolveWithErr,
        clear,
        failAll,
    };
}

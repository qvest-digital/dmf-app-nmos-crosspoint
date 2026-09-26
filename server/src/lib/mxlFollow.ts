/*
 * Pure rules for keeping MXL receivers on the flow their sender writes.
 *
 * An MXL sender can move to another flow while it runs: a writer deriving the
 * flow id from the stream's format writes a new flow when the format changes,
 * and its old flow is removed. A receiver keeps reading the flow it was
 * pointed at, so it has to be pointed again. Free of state and I/O like
 * transport.ts; nmosConnector keeps the state and sends the PATCHes.
 *
 * A receiver naming its sender is compared with the flow that sender writes
 * now, whenever either /active is read (mxlReceiversOffFlow), so nothing has
 * to have been seen before. A receiver naming no sender is linked to one only
 * by the flow it reads, so it follows when a move is seen (mxlSenderStep,
 * mxlUnnamedReceiversOnFlow).
 *
 * Not gated by reconnectReceiversOnSenderChange. That setting decides whether
 * an RTP receiver is activated again with a sender's changed SDP; left alone,
 * it keeps receiving what it joined. An MXL receiver left alone reads a flow
 * no one writes any more, which no operator wants, and the PATCH names the
 * sender it already takes.
 */

import { MxlEndpoint } from "./nmosConnectionPatch";
import { transportFamily, mxlReceiverReads } from "./transport";

/** What was last seen of one MXL sender. */
export interface MxlSenderSeen {
    /** The last flow its /active named. A read naming none -- the sender is
     *  off, or its writer has no stream to write -- leaves it as it was. */
    endpoint: MxlEndpoint | null;
    /** Its IS-04 flow_id at that read. */
    nmosFlowId: string | null;
}

export interface MxlSenderStep {
    seen: MxlSenderSeen;
    /** follow: the sender writes another flow than before, receivers naming
     *  no sender and reading `from` are pointed at the new one. reread: IS-04 names a new flow but
     *  /active does not yet, read /active once more. */
    action: "follow" | "reread" | "none";
    from: MxlEndpoint | null;
}

function sameEndpoint(a: MxlEndpoint, b: MxlEndpoint): boolean {
    return a.flowId === b.flowId && a.domainId === b.domainId;
}

/**
 * Fold one read of an MXL sender's /active into what was seen of it.
 *
 * Only a move from one resolved flow to another is a move. A read naming no
 * flow is not: a receiver pointed at nothing reads nothing either, and the
 * flow it has may come back. A first sighting has nothing to compare with.
 *
 * @param last what was seen before, null on a first sighting
 * @param endpoint resolvedMxlEndpoint of the /active just read
 * @param nmosFlowId the sender's IS-04 flow_id at this read
 */
export function mxlSenderStep(last: MxlSenderSeen | null, endpoint: MxlEndpoint | null, nmosFlowId: string | null): MxlSenderStep {
    const seen: MxlSenderSeen = { endpoint: endpoint || (last ? last.endpoint : null), nmosFlowId: nmosFlowId || null };
    if (!last) return { seen, action: "none", from: null };
    if (endpoint && last.endpoint && !sameEndpoint(endpoint, last.endpoint)) {
        return { seen, action: "follow", from: last.endpoint };
    }
    // IS-04 moved and /active did not: a device may register the new flow
    // before it answers for it in /active. Once, since seen now holds the
    // new IS-04 id.
    if (seen.nmosFlowId && seen.nmosFlowId !== last.nmosFlowId) {
        return { seen, action: "reread", from: null };
    }
    return { seen, action: "none", from: null };
}

/** One re-patch per receiver per value of this: a receiver pointed at a flow
 *  and still reading another is not pointed again until the sender moves. */
export function mxlRepatchKey(senderId: string, endpoint: MxlEndpoint): string {
    return senderId + "|" + endpoint.domainId + "|" + endpoint.flowId;
}

/** A running MXL receiver switched on in IS-05, or null. */
function runningMxl(receiver: any, active: any): any {
    if (!receiver || transportFamily(receiver.transport) !== "mxl") return null;
    const sub = receiver.subscription;
    if (!sub || !sub.active) return null;
    if (active && active.master_enable === false) return null;
    return sub;
}

/**
 * The receivers taking `senderId` by name -- IS-04 subscription, else IS-05
 * /active -- whose /active reads another flow or domain than `endpoint`, the
 * one the sender writes now. Level-based, so a receiver left on an old flow
 * is found whenever it is looked at, including the first time after a
 * restart. Skipped: a receiver whose /active is not known yet, one that is
 * off (the PATCH would switch it on), and one already pointed at this value
 * of the sender's flow (`patched`, see mxlRepatchKey).
 *
 * @param receivers IS-04 receivers per id
 * @param receiverActiveData IS-05 /active per receiver id, where read
 * @param patched mxlRepatchKey of the last re-patch per receiver id
 */
export function mxlReceiversOffFlow(senderId: string, endpoint: MxlEndpoint, receivers: { [id: string]: any },
    receiverActiveData: { [id: string]: any }, patched: { get(id: string): string | undefined }): string[] {
    const out: string[] = [];
    const key = mxlRepatchKey(senderId, endpoint);
    for (const id of Object.keys(receivers || {})) {
        const active = receiverActiveData ? receiverActiveData[id] : null;
        const sub = runningMxl(receivers[id], active);
        if (!sub || !active) continue;
        const named = sub.sender_id || active.sender_id || "";
        if (named !== senderId) continue;
        if (mxlReceiverReads(active, endpoint)) continue;
        if (patched && patched.get(id) === key) continue;
        out.push(id);
    }
    return out;
}

/**
 * The running MXL receivers naming no sender whose /active reads `from`, the
 * flow a sender has just left. Edge-based: without a sender id the flow is
 * the only link, and it is gone once the move has been seen.
 */
export function mxlUnnamedReceiversOnFlow(from: MxlEndpoint, receivers: { [id: string]: any }, receiverActiveData: { [id: string]: any }): string[] {
    const out: string[] = [];
    for (const id of Object.keys(receivers || {})) {
        const active = receiverActiveData ? receiverActiveData[id] : null;
        const sub = runningMxl(receivers[id], active);
        if (!sub || !active || sub.sender_id || active.sender_id) continue;
        if (mxlReceiverReads(active, from)) out.push(id);
    }
    return out;
}

/**
 * Orders overlapping reads of one resource. An answer is taken when no later
 * read has been taken yet, so a late answer to an older read cannot replace a
 * newer one, and an older answer still counts when the newer read fails.
 */
export class ReadOrder {
    private issued = new Map<string, number>();
    private taken = new Map<string, number>();

    begin(key: string): number {
        const seq = (this.issued.get(key) || 0) + 1;
        this.issued.set(key, seq);
        return seq;
    }

    /** Whether the answer to read `seq` is taken; records it when it is. */
    take(key: string, seq: number): boolean {
        if (seq <= (this.taken.get(key) || 0)) return false;
        this.taken.set(key, seq);
        return true;
    }

    forget(key: string) {
        this.issued.delete(key);
        this.taken.delete(key);
    }
}

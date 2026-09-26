/*
 * Pure rules for keeping MXL receivers on the flow their sender writes.
 *
 * An MXL sender can move to another flow while it runs: a writer deriving the
 * flow id from the stream's format writes a new flow when the format changes,
 * and its old flow is removed. A receiver keeps reading the flow it was
 * pointed at, so it has to be pointed again. Free of state and I/O like
 * transport.ts; nmosConnector keeps the state and sends the PATCHes.
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
    /** follow: the sender writes another flow than before, receivers on
     *  `from` are pointed at the new one. reread: IS-04 names a new flow but
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
 * Only a move from one resolved flow to another is followed. A read naming no
 * flow is never followed: a receiver pointed at nothing reads nothing either,
 * and the flow it has may come back. A first sighting has nothing to compare
 * with, so it is not followed either.
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

/**
 * The running MXL receivers taking `senderId` while it wrote `from`: those
 * naming it in IS-04 or IS-05, and those naming no sender whose /active reads
 * `from`. A receiver naming another sender is not touched, nor one that is
 * off -- pointing it again would switch it on.
 *
 * @param receivers IS-04 receivers per id
 * @param receiverActiveData IS-05 /active per receiver id, where read
 */
export function mxlReceiversToFollow(senderId: string, from: MxlEndpoint, receivers: { [id: string]: any }, receiverActiveData: { [id: string]: any }): string[] {
    const out: string[] = [];
    for (const id of Object.keys(receivers || {})) {
        const receiver = receivers[id];
        if (!receiver || transportFamily(receiver.transport) !== "mxl") continue;
        const sub = receiver.subscription;
        if (!sub || !sub.active) continue;
        const active = receiverActiveData ? receiverActiveData[id] : null;
        if (sub.sender_id) {
            if (sub.sender_id === senderId) out.push(id);
            continue;
        }
        if (active && active.sender_id) {
            if (active.sender_id === senderId) out.push(id);
            continue;
        }
        if (active && active.master_enable !== false && mxlReceiverReads(active, from)) out.push(id);
    }
    return out;
}

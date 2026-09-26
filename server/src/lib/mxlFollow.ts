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
 * mxlUnnamedFollowers). mxlRepatchTargets combines the two. Either PATCH names
 * the sender, so a receiver followed by its flow names the sender afterwards.
 *
 * Which sender a receiver takes is decided by its IS-05 /active when that
 * names one, else by its IS-04 subscription (mxlNamedSender). A controller
 * that patches only transport_params leaves sender_id naming the sender the
 * receiver had before, so that sender's flow is taken as the one it should
 * read and the receiver is pointed back at it.
 *
 * Not gated by reconnectReceiversOnSenderChange. That setting decides whether
 * an RTP receiver is activated again with a sender's changed SDP; left alone,
 * it keeps receiving what it joined. An MXL receiver left alone reads a flow
 * no one writes any more, which no operator wants, and the PATCH names the
 * sender it already takes.
 */

import * as jsonpatch from "fast-json-patch";
import { MxlEndpoint, resolvedMxlEndpoint } from "./nmosConnectionPatch";
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

/**
 * The sender a receiver takes by name: the one its IS-05 /active names, else
 * the one its IS-04 subscription names. "" when neither names one, null when
 * both name one and they differ: then it is not known which it takes.
 */
export function mxlNamedSender(subscription: any, active: any): string | null {
    const byActive = active && active.sender_id ? "" + active.sender_id : "";
    const bySub = subscription && subscription.sender_id ? "" + subscription.sender_id : "";
    if (byActive && bySub && byActive !== bySub) return null;
    return byActive || bySub;
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
        if (mxlNamedSender(sub, active) !== senderId) continue;
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
        if (!sub || !active || mxlNamedSender(sub, active) !== "") continue;
        if (mxlReceiverReads(active, from)) out.push(id);
    }
    return out;
}

/** Whether an MXL sender other than `senderId` writes `endpoint` now. */
export function mxlFlowWrittenByOther(endpoint: MxlEndpoint, senderId: string, senders: { [id: string]: any },
    senderActiveData: { [id: string]: any }): boolean {
    for (const id of Object.keys(senderActiveData || {})) {
        if (id === senderId) continue;
        const sender = senders ? senders[id] : null;
        if (!sender || transportFamily(sender.transport) !== "mxl") continue;
        const written = resolvedMxlEndpoint(senderActiveData[id]);
        if (written && sameEndpoint(written, endpoint)) return true;
    }
    return false;
}

/**
 * The receivers naming no sender that follow `senderId` off `from`, the flow
 * it has just left: mxlUnnamedReceiversOnFlow, or none while another MXL
 * sender still writes `from`, since a receiver reading it may be that one's.
 */
export function mxlUnnamedFollowers(senderId: string, from: MxlEndpoint, receivers: { [id: string]: any },
    receiverActiveData: { [id: string]: any }, senders: { [id: string]: any }, senderActiveData: { [id: string]: any }): string[] {
    if (mxlFlowWrittenByOther(from, senderId, senders, senderActiveData)) return [];
    return mxlUnnamedReceiversOnFlow(from, receivers, receiverActiveData);
}

/**
 * Whether a receiver chosen by mxlRepatchTargets is still to be pointed at
 * `endpoint`, checked again just before its PATCH: an operator may have
 * switched it off or routed it elsewhere since. It has to be a running MXL
 * receiver with a known /active that has it switched on and reads another
 * flow, and either take `senderId` by name, or name no sender and read
 * `from`, the flow the sender left, with no other sender writing that.
 */
export function mxlRepatchEligible(senderId: string, endpoint: MxlEndpoint, receiver: any, active: any,
    from: MxlEndpoint | null, senders: { [id: string]: any }, senderActiveData: { [id: string]: any }): boolean {
    const sub = runningMxl(receiver, active);
    if (!sub || !active) return false;
    if (mxlReceiverReads(active, endpoint)) return false;
    const named = mxlNamedSender(sub, active);
    if (named === senderId) return true;
    if (named !== "" || !from) return false;
    return mxlReceiverReads(active, from) && !mxlFlowWrittenByOther(from, senderId, senders, senderActiveData);
}

/**
 * Whether a failed re-patch was the receiver refusing the flow: a 4xx
 * answer (`status`), or a domain its constraints exclude (`refused`, no
 * PATCH sent). Asking again gets the same answer until the sender moves.
 */
export function mxlRefused(error: any): boolean {
    if (!error) return false;
    if (error.refused === true) return true;
    return typeof error.status === "number" && error.status >= 400 && error.status < 500;
}

/**
 * Settle the claim mxlRepatchTargets put on receiver `id` under `key` once
 * its re-patch is over. Kept when the PATCH was taken or refused, as
 * `sentKey` when the flow re-read before patching differed from the claimed
 * one. Released when nothing was sent (the sender could not be read or was
 * off, the receiver no longer qualified) or the attempt failed otherwise, so
 * a later read tries again. A claim made meanwhile is left alone.
 */
export function mxlSettleClaim(patched: Map<string, string>, id: string, key: string,
    outcome: "patched" | "skipped" | { error: any }, sentKey: string = key) {
    if (patched.get(id) !== key) return;
    const kept = outcome === "patched" || (typeof outcome === "object" && mxlRefused(outcome.error));
    if (kept) patched.set(id, sentKey);
    else patched.delete(id);
}

/** Whether a receiver's /active read now says anything else than before. */
export function receiverActiveChanged(before: any, after: any): boolean {
    if (!before || !after || typeof before !== "object" || typeof after !== "object") return before !== after;
    return jsonpatch.compare(before, after).length > 0;
}

/**
 * The receivers to re-patch onto `endpoint`, the flow `senderId` writes now,
 * with `patched` brought up to date. Targets are the mxlReceiversOffFlow ones
 * plus those of `unnamed` (see mxlUnnamedReceiversOnFlow) not already patched
 * to this value; each is claimed in `patched` before the PATCH goes out, so a
 * read landing meanwhile does not send a second one, and the claim is kept
 * when the PATCH fails, so a receiver refusing the flow is not asked again
 * while the sender stays on it. A receiver patched for this sender and seen
 * reading the flow it writes now has its claim dropped: it is where it
 * belongs, and if the sender moves again it is asked again, also to a flow it
 * refused before. The claim of a receiver that is gone or no longer a running
 * MXL receiver is dropped too.
 *
 * @param patched mxlRepatchKey of the last re-patch per receiver id, updated
 */
export function mxlRepatchTargets(senderId: string, endpoint: MxlEndpoint, receivers: { [id: string]: any },
    receiverActiveData: { [id: string]: any }, patched: Map<string, string>, unnamed: string[] = []): string[] {
    for (const [id, claim] of Array.from(patched)) {
        const receiver = receivers ? receivers[id] : null;
        if (!receiver || transportFamily(receiver.transport) !== "mxl" || !receiver.subscription?.active) {
            patched.delete(id);
            continue;
        }
        if (!claim.startsWith(senderId + "|")) continue;
        if (mxlReceiverReads(receiverActiveData ? receiverActiveData[id] : null, endpoint)) patched.delete(id);
    }
    const key = mxlRepatchKey(senderId, endpoint);
    const ids = mxlReceiversOffFlow(senderId, endpoint, receivers, receiverActiveData, patched);
    for (const id of unnamed) {
        if (!ids.includes(id) && patched.get(id) !== key) ids.push(id);
    }
    for (const id of ids) patched.set(id, key);
    return ids;
}

/**
 * Orders overlapping reads of one resource. An answer is taken when no later
 * read has been taken yet, so a late answer to an older read cannot replace a
 * newer one, and an older answer still counts when the newer read fails. A
 * read begun before the resource was forgotten is never taken: its answer
 * describes something that is gone, or an earlier life of it.
 */
export class ReadOrder {
    private last = 0;
    // First read begun on each key since it was last forgotten.
    private first = new Map<string, number>();
    private taken = new Map<string, number>();

    begin(key: string): number {
        const seq = ++this.last;
        if (!this.first.has(key)) this.first.set(key, seq);
        return seq;
    }

    /** Whether the answer to read `seq` is taken; records it when it is. */
    take(key: string, seq: number): boolean {
        const first = this.first.get(key);
        if (first === undefined || seq < first) return false;
        if (seq <= (this.taken.get(key) || 0)) return false;
        this.taken.set(key, seq);
        return true;
    }

    forget(key: string) {
        this.first.delete(key);
        this.taken.delete(key);
    }

    /** Forget every key. */
    clear() {
        this.first.clear();
        this.taken.clear();
    }
}

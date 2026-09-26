import { ComplexCompare } from "./functions";

// Device order in the crosspoint state, and so in the matrix: by crosspoint
// number, ascending. A device without one (-1) comes after every numbered
// device. Equal numbers and unnumbered devices follow their label in
// natural order ("Source 2" before "Source 10"), then their id, so the
// order never depends on the order the registry announced them in.

interface OrderedDevice {
    id: string;
    num: number;
    displayLabel?: string;
    alias?: string;
    name?: string;
}

function isNumbered(num: number): boolean {
    return Number.isFinite(num) && num > 0;
}

function orderLabel(d: OrderedDevice): string {
    return "" + (d.displayLabel || d.alias || d.name || "");
}

export function compareDevices(a: OrderedDevice, b: OrderedDevice): number {
    let an = isNumbered(a.num), bn = isNumbered(b.num);
    if (an && bn && a.num != b.num) { return a.num - b.num; }
    if (an != bn) { return an ? -1 : 1; }
    let la = orderLabel(a), lb = orderLabel(b);
    // ComplexCompare reads "Sink" and "Sink 1" as equal: it stops at the
    // end of the shorter label.
    return ComplexCompare(la, lb) || la.localeCompare(lb) || ("" + a.id).localeCompare("" + b.id);
}

/** Sorts in place and returns the same array. */
export function sortDevices<T extends OrderedDevice>(devices: T[]): T[] {
    return devices.sort(compareDevices);
}

/**
 * Gives device `devId` the crosspoint number `newNum`. A device already
 * holding `newNum` takes the moved device's old number, so two devices never
 * end up sharing one through a move. -1 clears the number. Returns whether
 * anything changed; an unknown device, 0 or a non-number changes nothing.
 */
export function moveDeviceNum(devices: { [id: string]: { num: number } }, devId: string, newNum: any): boolean {
    let dev = devices[devId];
    if (!dev) { return false; }
    let num = Number.parseInt("" + newNum);
    if (!(num == -1 || num > 0) || num == dev.num) { return false; }
    let oldNum = dev.num;
    if (num > 0) {
        for (let id of Object.keys(devices)) {
            if (devices[id].num == num) { devices[id].num = oldNum; }
        }
    }
    dev.num = num;
    return true;
}

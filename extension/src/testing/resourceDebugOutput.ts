import * as assert from 'assert';
import type { DebugAdapterOutputEvent } from './e2eStateFileBridge';

export interface ResourceDebugOutputProof {
    resourceDebugSession?: { id: string };
    outputHead: readonly DebugAdapterOutputEvent[];
    outputSample: readonly DebugAdapterOutputEvent[];
}

/**
 * Reads a pid the debuggee printed, for example:
 *   ASPIRE_E2E_NODE_CHILD_PID=54321
 * The value arrives as DAP `output` events, which can split or batch lines, so the whole captured
 * output is searched rather than a single event.
 */
export function readReportedPidFromDebugOutput(proof: ResourceDebugOutputProof, marker: string): number {
    const events = [...proof.outputHead, ...proof.outputSample];
    const stoppedSessionEvents = events.filter(event => event.sessionId === proof.resourceDebugSession?.id);
    const stoppedSessionMatches = findPidMatches(stoppedSessionEvents, marker);
    const matches = stoppedSessionMatches.length > 0
        ? stoppedSessionMatches
        : findPidMatches(events, marker);

    assert.ok(matches.length > 0, `Expected the debuggee to print ${marker} in its debug output: ${JSON.stringify(events)}`);

    return Number(matches[matches.length - 1][1]);
}

function findPidMatches(events: readonly DebugAdapterOutputEvent[], marker: string): RegExpMatchArray[] {
    const output = events.map(event => event.output).join('');

    return [...output.matchAll(new RegExp(`${marker}=(\\d+)`, 'g'))];
}
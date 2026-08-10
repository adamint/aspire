import { AnsiColors, applyTextStyle } from '../utils/strings';

export type AppHostLogLevel = 'Trace' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Critical';

export interface AppHostLogEntry {
    sequenceNumber: number;
    timestamp: string;
    logLevel: AppHostLogLevel;
    message: string;
    categoryName: string;
    eventId: number;
    eventName?: string | null;
    exception?: string | null;
}

export interface AppHostParentOutput {
    output: string;
    category: 'stdout' | 'stderr';
}

type AppHostLogSource = 'backchannel' | 'consoleLogger' | 'debugLogger';

interface AppHostLoggerRecord {
    categoryName: string;
    logLevel: AppHostLogLevel;
    message: string;
    eventId?: number;
    exception?: string;
}

interface CorrelatedRecord {
    record: AppHostLoggerRecord;
    sources: Set<AppHostLogSource>;
}

interface PendingConsoleRecord {
    header: string;
    body: string;
    category: string;
}

interface PendingDebugRecord {
    text: string;
    category: string;
}

export class AppHostLogOutputCoordinator {
    // Correlation is one-for-one, so repeated identical ILogger calls remain distinct.
    // The queue only needs to bridge provider/RPC interleaving and is owned by one
    // Aspire debug session; older records are never used for broad message suppression.
    private static readonly _maxCorrelatedRecords = 1024;
    private static readonly _allSources: readonly AppHostLogSource[] = ['backchannel', 'consoleLogger', 'debugLogger'];
    private static readonly _adapterOnlyIdleFlushDelayMs = 250;
    private readonly _correlatedRecords: CorrelatedRecord[] = [];
    private readonly _fallbackFilter = new AppHostParentOutputFilter();
    private readonly _partialLines = new Map<string, string>();
    private readonly _idleFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _highestBackchannelSequence = 0;
    // `stdout`, `stderr` and `console` are independent streams that interleave freely, so a
    // record being assembled on one of them says nothing about the others. A single pending
    // record would let an unrelated write on another stream terminate a record mid-assembly,
    // rendering the truncated half and leaking the rest.
    private readonly _pendingRecords = new Map<string, PendingConsoleRecord>();
    private readonly _pendingDebugRecords = new Map<string, PendingDebugRecord>();

    constructor(
        private readonly _onIdleFlush?: (output: AppHostParentOutput) => void,
        private readonly _idleFlushDelayMs = AppHostLogOutputCoordinator._adapterOnlyIdleFlushDelayMs) {
    }

    handleBackchannelEntry(entry: AppHostLogEntry): AppHostParentOutput | undefined {
        if (entry.sequenceNumber > 0) {
            // A transient CLI/AppHost backchannel reconnect re-subscribes to the
            // provider's replay buffer. Sequence numbers are monotonic for one
            // AppHost process, so a lower/equal value is the same record, not a
            // repeated message that should be shown again.
            if (entry.sequenceNumber <= this._highestBackchannelSequence) {
                return undefined;
            }

            this._highestBackchannelSequence = entry.sequenceNumber;
        }

        return this.correlate({
            categoryName: entry.categoryName,
            logLevel: entry.logLevel,
            message: normalizeRecordText(entry.message),
            eventId: entry.eventId,
            exception: normalizeOptionalRecordText(entry.exception)
        }, 'backchannel');
    }

    /**
     * Consumes one debug adapter output event and returns whatever became renderable.
     *
     * A record is only known to have ended once a line that cannot continue it arrives, so
     * the last record of a burst stays buffered until the next event, the idle flush, or
     * {@link flush}. Guessing that a record had ended instead would render it truncated and
     * leak the rest as raw text whenever a stream chunk happened to break on a line boundary
     * inside the record.
     *
     * Information and above cost no visible latency, because the CLI relays the same record
     * over its own path — structured for a capable extension, a dim message for an older one —
     * and whichever copy lands first is the one rendered. Trace and Debug have no such twin:
     * {@link https://github.com/microsoft/aspire/blob/main/src/Aspire.Cli/Commands/RunCommand.cs RunCommand}
     * deliberately does not forward them, so a final low-level record waits for the idle flush
     * scheduled by {@link scheduleIdleFlushIfNeeded} — the reason that timer exists.
     */
    handleDebugAdapterOutput(output: string, category: string | undefined): AppHostParentOutput[] {
        const normalizedCategory = category ?? 'console';
        const outputs: AppHostParentOutput[] = [];

        this.clearIdleFlushTimer(normalizedCategory);

        const buffered = `${this._partialLines.get(normalizedCategory) ?? ''}${output}`;
        const lastBreak = findLastCompletedLineBreak(buffered);
        const completeLines = buffered.slice(0, lastBreak + 1);
        let partial = buffered.slice(lastBreak + 1);

        if (completeLines.length > 0) {
            this.consumeLines(completeLines, normalizedCategory, outputs);
        }

        // Decide about the trailing partial line only after the complete lines have been
        // consumed, because whether a record is being assembled is exactly what makes an
        // unterminated line worth waiting for.
        if (partial.length > 0 && !partial.endsWith('\r') && !this.shouldHoldPartialLine(partial, normalizedCategory)) {
            this.consumeLines(partial, normalizedCategory, outputs);
            partial = '';
        }

        if (partial.length > 0) {
            this._partialLines.set(normalizedCategory, partial);
        } else {
            this._partialLines.delete(normalizedCategory);
        }

        this.scheduleIdleFlushIfNeeded(normalizedCategory);

        return outputs;
    }

    /**
     * Emits whatever is still being assembled, without discarding correlation state.
     *
     * Records are assembled across output events, so an AppHost that exits right after
     * logging would otherwise take the final record with it — exactly the `fail:`/`crit:`
     * line the user needs to see. Correlation state is kept so a backchannel copy still
     * in flight is recognized as a duplicate rather than rendered again.
     */
    flush(): AppHostParentOutput[] {
        this.clearIdleFlushTimers();

        const outputs: AppHostParentOutput[] = [];
        const partials = [...this._partialLines.entries()];
        this._partialLines.clear();

        for (const [category, partial] of partials) {
            this.consumeLines(partial, category, outputs);
        }

        for (const category of [...this._pendingRecords.keys()]) {
            this.flushPendingRecord(category, outputs);
        }

        for (const category of [...this._pendingDebugRecords.keys()]) {
            this.flushPendingDebugRecord(category, outputs);
        }

        return outputs;
    }

    reset(): void {
        this._correlatedRecords.length = 0;
        this._highestBackchannelSequence = 0;
        this._pendingRecords.clear();
        this._pendingDebugRecords.clear();
        this._partialLines.clear();
        this.clearIdleFlushTimers();
        this._fallbackFilter.reset();
    }

    /**
     * Decides whether an unterminated trailing line is worth waiting on.
     *
     * Debug adapter output is not aligned to record boundaries: a redirected
     * `Console.Out` flushes every 256 characters, so a long record reaches the adapter in
     * several writes and parsing a chunk that stops mid-line would render a truncated
     * record and leak the remainder as raw text. Holding text also delays it until the
     * next write, so only hold when it plausibly belongs to a logger record —
     * unstructured writes such as a progress indicator printed without a newline still
     * reach the console immediately.
     */
    private shouldHoldPartialLine(partial: string, category: string): boolean {
        // `console` carries DebugLogger and adapter output only, never interactive
        // writes, so nothing observable is delayed by buffering it.
        if (category === 'console') {
            return true;
        }

        if (this._pendingRecords.has(category)) {
            return true;
        }

        return couldStartConsoleLoggerHeader(partial);
    }

    private consumeLines(text: string, category: string, outputs: AppHostParentOutput[]): void {
        const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
        let passthrough = '';

        const flushPassthrough = () => {
            if (passthrough.length === 0) {
                return;
            }

            const block = passthrough;
            passthrough = '';

            const filtered = this._fallbackFilter.filter(block, category);
            if (filtered) {
                outputs.push(filtered);
            }
        };

        for (const line of lines) {
            if (category === 'console') {
                // System.Diagnostics.Debug output is delivered as DAP `console` output,
                // while Console.WriteLine uses stdout/stderr. Restrict the DebugLogger
                // grammar to that provenance so user stdout shaped like
                // "Status: Error: connection refused" is never reclassified.
                if (isDebugLoggerHeader(line)) {
                    const pending = this._pendingDebugRecords.get(category);
                    if (pending && this.continuesPendingDebugRecord(pending, line)) {
                        pending.text += line;
                        continue;
                    }

                    flushPassthrough();
                    this.flushPendingDebugRecord(category, outputs);
                    this._pendingDebugRecords.set(category, { text: line, category });
                    continue;
                }

                const pendingDebugRecord = this._pendingDebugRecords.get(category);
                if (pendingDebugRecord) {
                    if (startsUnrelatedDebuggerOutput(line) ||
                        this.hasCompletedBackchannelTwin(parseDebugLoggerRecord(pendingDebugRecord.text))) {
                        flushPassthrough();
                        this.flushPendingDebugRecord(category, outputs);
                    } else {
                        pendingDebugRecord.text += line;
                        continue;
                    }
                }
            }

            const pending = this._pendingRecords.get(category);
            if (pending && isConsoleLoggerContinuation(line) && !this.startsUnrelatedConsoleOutput(pending, line)) {
                pending.body += line;
                continue;
            }

            this.flushPendingRecord(category, outputs);

            if (isConsoleLoggerHeader(line)) {
                flushPassthrough();
                this._pendingRecords.set(category, { header: line, body: '', category });
                continue;
            }

            passthrough += line;
        }

        flushPassthrough();
    }

    /**
     * Decides whether a header-shaped line continues the pending DebugLogger record instead of
     * starting a new one.
     *
     * `Debug.WriteLine(message, category)` prefixes only the first line of a record, so a
     * multi-line message whose continuation happens to read like `Category: Error: detail` is
     * textually identical to two adjacent records:
     *
     *   Example.Category: Warning: Deployment failed.
     *   Other.Category: Error: image pull failed.
     *
     * Nothing in the text resolves that, and both readings occur, so the only evidence is a copy
     * of the same record from another provider. When the merged reading matches one already seen,
     * the line belongs to this record; otherwise the boundary reading is kept, because adjacent
     * records are the common case and merging them would corrupt both.
     *
     * The evidence only exists when the twin arrived first. A DebugLogger copy that wins the race
     * is still split, so the ambiguity is reduced rather than eliminated.
     */
    private continuesPendingDebugRecord(pending: PendingDebugRecord, line: string): boolean {
        const merged = parseDebugLoggerRecord(`${pending.text}${line}`);
        if (!merged) {
            return false;
        }

        return this._correlatedRecords.some(candidate =>
            !candidate.sources.has('debugLogger') && areEquivalentRecords(candidate.record, merged));
    }

    /**
     * Reports whether the record assembled so far already has a backchannel copy waiting for its
     * twin.
     *
     * The CLI relays one complete record per backchannel entry, so a pending DebugLogger record
     * that already equals one cannot still be growing: the next line belongs to something else.
     * Without this an unrelated `Debug.WriteLine` inside the idle window would be appended to a
     * warning, breaking the identity that dedupe depends on and rendering both copies.
     *
     * Trace and Debug have no backchannel twin, so they still rely on the idle flush.
     */
    /// Reports whether the record being assembled has already arrived complete over the
    /// backchannel. Once it has, the record is finished by definition and any further line belongs
    /// to something else, so appending it would destroy the identity the deduplicator matches on
    /// and the record would render a second time with the unrelated line inside it.
    private hasCompletedBackchannelTwin(record: AppHostLoggerRecord | undefined): boolean {
        if (!record) {
            return false;
        }

        return this._correlatedRecords.some(candidate =>
            candidate.sources.has('backchannel') &&
            !candidate.sources.has('debugLogger') &&
            !candidate.sources.has('consoleLogger') &&
            isCompletedTwin(candidate.record, record));
    }

    private flushPendingDebugRecord(category: string, outputs: AppHostParentOutput[]): void {
        const pending = this._pendingDebugRecords.get(category);
        if (!pending) {
            return;
        }

        this._pendingDebugRecords.delete(category);

        const record = parseDebugLoggerRecord(pending.text);
        if (record) {
            this.emitRecord(record, 'debugLogger', pending.text, pending.category, outputs);
            return;
        }

        const filtered = this._fallbackFilter.filter(pending.text, pending.category);
        if (filtered) {
            outputs.push(filtered);
        }
    }

    /// Decides whether an indented line that looks like a SimpleConsoleFormatter continuation is
    /// really a different writer's output. Six-space indentation is the only signal the formatter
    /// gives, so `Console.WriteLine("      progress")` right after a log call is indistinguishable
    /// from the record's own body until the backchannel copy of that record arrives complete. Once
    /// it has, the record is finished and absorbing the line would change the text the deduplicator
    /// matches on, rendering the log a second time with the stray line restyled inside it.
    private startsUnrelatedConsoleOutput(pending: PendingConsoleRecord, line: string): boolean {
        // Two kinds of line legitimately extend a record whose message already equals its twin's.
        // A blank one is the tail of a message that ended with a newline, which normalizeRecordText
        // strips from both copies before they are compared. An exception block is the part of the
        // record the AppHost could not send over the backchannel separately, so the twin carries
        // the message alone. Neither can prove a different writer is now emitting.
        const content = normalizeLineEndings(line).split('\n', 1)[0];
        if (content.trim().length === 0 || startsExceptionBlock(content.slice(6))) {
            return false;
        }

        return this.hasCompletedBackchannelTwin(parseConsoleLoggerRecord(`${pending.header}${pending.body}`));
    }

    private flushPendingRecord(category: string, outputs: AppHostParentOutput[]): void {
        const pending = this._pendingRecords.get(category);
        if (!pending) {
            return;
        }

        this._pendingRecords.delete(category);
        const text = `${pending.header}${pending.body}`;

        const record = parseConsoleLoggerRecord(text);
        if (record) {
            this.emitRecord(record, 'consoleLogger', text, pending.category, outputs);
            return;
        }

        const filtered = this._fallbackFilter.filter(text, pending.category);
        if (filtered) {
            outputs.push(filtered);
        }
    }

    private scheduleIdleFlushIfNeeded(category: string): void {
        const pending = this._pendingRecords.get(category);
        const hasPendingConsoleRecord = pending !== undefined && pending.body.length > 0;
        const hasPendingDebugRecord = this._pendingDebugRecords.has(category);
        const hasHeldPartialLine = this._partialLines.has(category);
        const isAssemblingRecord = this._pendingRecords.has(category) || this._pendingDebugRecords.has(category);

        if (!this._onIdleFlush) {
            return;
        }

        if (hasHeldPartialLine) {
            // A record being assembled keeps everything buffered, because the partial line is most
            // likely its next body line and emitting now would split the record.
            if (isAssemblingRecord) {
                return;
            }
        } else if (!hasPendingConsoleRecord && !hasPendingDebugRecord) {
            return;
        }

        // Trace/Debug records do not have a structured backchannel twin, and final
        // ConsoleLogger/DebugLogger records have no explicit terminator. Flush after a
        // short idle window so adapter-only records become visible without waiting for
        // AppHost shutdown. The same window bounds a held partial line: Console.Write("info: ...")
        // with no newline looks like the start of a logger header, and without a release it would
        // stay invisible until the next write or process exit.
        const timer = setTimeout(() => {
            this._idleFlushTimers.delete(category);

            const outputs: AppHostParentOutput[] = [];
            this.flushPendingRecord(category, outputs);
            this.flushPendingDebugRecord(category, outputs);
            this.releaseHeldPartialLine(category, outputs);

            for (const output of outputs) {
                this._onIdleFlush?.(output);
            }
        }, this._idleFlushDelayMs);

        this._idleFlushTimers.set(category, timer);
    }

    private releaseHeldPartialLine(category: string, outputs: AppHostParentOutput[]): void {
        const partial = this._partialLines.get(category);

        // Only an unterminated line that never became part of a record is released here. Once the
        // idle window has passed, waiting longer for a suffix costs more than emitting the prefix
        // twice would, because the alternative is showing nothing at all.
        if (partial === undefined || this._pendingRecords.has(category) || this._pendingDebugRecords.has(category)) {
            return;
        }

        this._partialLines.delete(category);
        this.consumeLines(partial, category, outputs);
    }

    private clearIdleFlushTimer(category: string): void {
        const timer = this._idleFlushTimers.get(category);
        if (timer === undefined) {
            return;
        }

        clearTimeout(timer);
        this._idleFlushTimers.delete(category);
    }

    private clearIdleFlushTimers(): void {
        for (const timer of this._idleFlushTimers.values()) {
            clearTimeout(timer);
        }

        this._idleFlushTimers.clear();
    }

    private emitRecord(
        record: AppHostLoggerRecord,
        source: AppHostLogSource,
        rawText: string,
        category: string,
        outputs: AppHostParentOutput[]): void {
        // Advance the fallback filter even though its output is discarded. It tracks
        // whether the previous line opened a suppressed trace/debug record or an error
        // block, so skipping consumed records leaves that state stale and the next
        // unstructured line is classified against the wrong record.
        this._fallbackFilter.filter(rawText, category);

        const correlated = this.correlate(record, source);
        if (correlated) {
            outputs.push(correlated);
        }
    }

    private correlate(record: AppHostLoggerRecord, source: AppHostLogSource): AppHostParentOutput | undefined {
        const existingIndex = this._correlatedRecords.findIndex(candidate =>
            !candidate.sources.has(source) && areEquivalentRecords(candidate.record, record));

        if (existingIndex >= 0) {
            const existing = this._correlatedRecords[existingIndex];
            existing.sources.add(source);

            // Once every provenance has been seen the record can never match again, so
            // drop it immediately. Otherwise the window fills with dead entries and
            // evicts records that are still waiting for their twin.
            if (existing.sources.size === AppHostLogOutputCoordinator._allSources.length) {
                this._correlatedRecords.splice(existingIndex, 1);
            }

            return undefined;
        }

        this._correlatedRecords.push({
            record,
            sources: new Set([source])
        });
        if (this._correlatedRecords.length > AppHostLogOutputCoordinator._maxCorrelatedRecords) {
            this._correlatedRecords.shift();
        }

        return formatLoggerRecord(record);
    }
}

export class AppHostParentOutputFilter {
    private _continuingDroppedLog = false;
    private _continuingErrorBlock = false;
    private _lastCategory: string | undefined;

    filter(output: string, category: string | undefined): AppHostParentOutput | undefined {
        // Per the DAP spec the `category` field is optional; clients should treat a
        // missing category as `'console'`. Normalize once at the boundary so state
        // tracking and per-line classification see a consistent value.
        const normalizedCategory = category ?? 'console';

        if (normalizedCategory === 'debug') {
            this.resetLineState();
            this._lastCategory = normalizedCategory;
            return undefined;
        }

        if (normalizedCategory !== this._lastCategory) {
            this.resetLineState();
        }
        this._lastCategory = normalizedCategory;

        const segments = output.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(segment => segment.length > 0) ?? [];
        let filteredOutput = '';
        let hasErrorOutput = normalizedCategory === 'stderr';

        for (const segment of segments) {
            const outputCategory = this.getLineCategory(segment, normalizedCategory);
            if (outputCategory) {
                filteredOutput += segment;
                hasErrorOutput ||= outputCategory === 'stderr';
            }
        }

        if (filteredOutput.length === 0) {
            return undefined;
        }

        return {
            output: filteredOutput,
            category: hasErrorOutput ? 'stderr' : 'stdout'
        };
    }

    reset(): void {
        this.resetLineState();
        this._lastCategory = undefined;
    }

    private getLineCategory(segment: string, category: string): 'stdout' | 'stderr' | undefined {
        const line = segment.replace(/(?:\r\n|\r|\n)$/, '');
        const trimmedLine = line.trim();

        if (trimmedLine.length === 0) {
            return !this._continuingDroppedLog && this.shouldMirrorConsoleOutput(category) ? this.getCurrentCategory(category) : undefined;
        }

        if (this._continuingDroppedLog && isIndentedContinuation(line)) {
            return undefined;
        }

        if (this._continuingErrorBlock && isIndentedContinuation(line)) {
            return 'stderr';
        }

        const logSeverity = getConsoleLogSeverity(trimmedLine);
        if (logSeverity) {
            this._continuingDroppedLog = logSeverity === 'low';
            this._continuingErrorBlock = logSeverity === 'severe';

            return logSeverity === 'low' ? undefined : this.getCurrentCategory(category);
        }

        const isSevereOutput = isSevereRuntimeOutputLine(trimmedLine);
        this._continuingDroppedLog = false;
        this._continuingErrorBlock = isSevereOutput;

        if (category === 'console' && !isSevereOutput) {
            return undefined;
        }

        return this.getCurrentCategory(category);
    }

    private shouldMirrorConsoleOutput(category: string): boolean {
        return category !== 'console' || this._continuingErrorBlock;
    }

    private getCurrentCategory(category: string): 'stdout' | 'stderr' {
        return category === 'stderr' || this._continuingErrorBlock ? 'stderr' : 'stdout';
    }

    private resetLineState(): void {
        this._continuingDroppedLog = false;
        this._continuingErrorBlock = false;
    }
}

function parseConsoleLoggerRecord(output: string): AppHostLoggerRecord | undefined {
    // SimpleConsoleFormatter emits one logical record as:
    //   warn: Example.Category[7]
    //         First message line.
    //         System.InvalidOperationException: boom
    // CoreCLR can split the header and indented body into separate DAP events;
    // AppHostLogOutputCoordinator joins that exact two-event shape before parsing.
    const normalized = normalizeLineEndings(output);
    const match = /^(trce|dbug|info|warn|fail|crit): (.+)\[(-?\d+)\]\n([\s\S]+)$/.exec(normalized);
    if (!match) {
        return undefined;
    }

    const bodyLines = removeSingleTrailingNewline(match[4]).split('\n');
    if (bodyLines.some(line => line.length > 0 && !line.startsWith('      '))) {
        return undefined;
    }

    const body = bodyLines.map(line => line.startsWith('      ') ? line.slice(6) : line).join('\n');
    const { message, exception } = splitMessageAndException(body);

    return {
        categoryName: match[2],
        logLevel: getFullLoggerLevel(match[1]),
        message: normalizeRecordText(message),
        eventId: Number(match[3]),
        exception: normalizeOptionalRecordText(exception)
    };
}

function isConsoleLoggerHeader(output: string): boolean {
    return /^(trce|dbug|info|warn|fail|crit): .+\[-?\d+\](?:\r\n|\r|\n)?$/.test(output);
}

const consoleLoggerLevelTokens = ['trce', 'dbug', 'info', 'warn', 'fail', 'crit'];

function couldStartConsoleLoggerHeader(text: string): boolean {
    // Compare against the full `level: ` prefix in both directions so every intermediate
    // state matches, including the one where the level is complete but the separator is
    // still arriving ("fail" -> "fail:" -> "fail: ").
    return consoleLoggerLevelTokens.some(token => {
        const prefix = `${token}: `;
        return prefix.startsWith(text) || text.startsWith(prefix);
    });
}

function findLastCompletedLineBreak(text: string): number {
    // DAP output is a byte stream. On Windows, a CRLF line ending can be split so
    // one OutputEvent ends with "\r" and the next starts with "\n". Treating that
    // trailing "\r" as a completed line makes the following "\n" look like a blank
    // continuation line, which changes the record identity used for deduplication.
    const lastLineFeed = text.lastIndexOf('\n');
    const lastCarriageReturn = text.endsWith('\r')
        ? text.lastIndexOf('\r', text.length - 2)
        : text.lastIndexOf('\r');

    return Math.max(lastLineFeed, lastCarriageReturn);
}

function isConsoleLoggerContinuation(output: string): boolean {
    const lines = normalizeLineEndings(output).split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }

    return lines.length > 0 && lines.every(line => line.length === 0 || line.startsWith('      '));
}

function parseDebugLoggerRecord(output: string): AppHostLoggerRecord | undefined {
    // DebugLogger emits a complete record as:
    //   Example.Category: Warning: First message line.
    //
    //   System.InvalidOperationException: boom
    const normalized = removeSingleTrailingNewline(normalizeLineEndings(output));
    const match = /^([^\n]+): (Trace|Debug|Information|Warning|Error|Critical): ([\s\S]*)$/.exec(normalized);
    if (!match) {
        return undefined;
    }

    const { message, exception } = splitMessageAndException(match[3]);
    return {
        categoryName: match[1],
        logLevel: match[2] as AppHostLogLevel,
        message: normalizeRecordText(message),
        exception: normalizeOptionalRecordText(exception)
    };
}

function isDebugLoggerHeader(output: string): boolean {
    return /^[^\r\n]+: (Trace|Debug|Information|Warning|Error|Critical): .*(?:\r\n|\r|\n)?$/.test(output);
}

function startsUnrelatedDebuggerOutput(line: string): boolean {
    // A DebugLogger record's continuation lines are arbitrary user text, so a pending
    // record otherwise absorbs every following `console` line. The debugger itself
    // writes on that same category, and those lines are never part of a record:
    //   'TestShop.AppHost' (CoreCLR: clrhost): Loaded '/dotnet/System.Private.CoreLib.dll'. Skipped loading symbols.
    //   TestShop.AppHost.dll (29067): Loaded '/dotnet/System.Net.Http.dll'. No se puede encontrar o abrir el archivo PDB.
    //   Loaded '/dotnet/System.Net.Http.dll'. Skipped loading symbols.
    //   Exception thrown: 'System.InvalidOperationException' in TestShop.AppHost.dll
    //   -------------------------------------------------------------------------------
    //   Unhandled exception. System.InvalidOperationException: boom
    // Absorbing them rewrites the record text, which changes the identity used for
    // deduplication, and hides a fatal line behind the pending record's log level
    // instead of routing it to stderr.
    //
    // Every pattern is anchored, and the module-load prefix is required to be either absent or a
    // parenthesised module/pid tag, so ordinary content such as "Plugin Loaded 'foo'." is not
    // mistaken for debugger output. The list stays conservative on purpose. It cannot be
    // exhaustive, because the debugger localizes most of what it writes (the launch-settings and
    // licence lines in dotnetDebugger.test.ts are Spanish and English copies of the same
    // messages), and a wrong break is the more expensive error: a Trace or Debug record has no
    // backchannel twin, so its continuation would be dropped by the console fallback and lost,
    // whereas a wrong absorb only spoils one record's identity.
    const trimmedLine = line.trim();

    return /^Unhandled exception\./.test(trimmedLine)
        || /^(?:'[^']*' \([^)]*\): |\S+ \(\d+\): )?Loaded '[^']*'\./.test(trimmedLine)
        || /^Exception thrown: '/.test(trimmedLine)
        || /^-{5,}$/.test(trimmedLine);
}

function startsExceptionBlock(line: string): boolean {
    return /^(?:[A-Za-z_][\w`]*(?:\.[A-Za-z_][\w`]*)*(?:Exception|Error)(?: \([^)]*\))?:|Unhandled exception\.)/.test(line);
}

function splitMessageAndException(value: string): { message: string; exception?: string } {
    // Exception.ToString() starts with the type name followed by ": " and the message,
    // except for the Win32Exception family, which inserts the native error code:
    //   System.InvalidOperationException: boom
    //   System.Net.Sockets.SocketException (111): Connection refused
    //   System.ComponentModel.Win32Exception (2): No such file or directory
    // https://learn.microsoft.com/dotnet/api/system.componentmodel.win32exception.tostring
    const lines = normalizeLineEndings(value).split('\n');
    const exceptionIndex = lines.findIndex(startsExceptionBlock);

    if (exceptionIndex < 0) {
        return { message: value };
    }

    const messageLines = lines.slice(0, exceptionIndex);
    if (messageLines.at(-1) === '') {
        messageLines.pop();
    }

    return {
        message: messageLines.join('\n'),
        exception: lines.slice(exceptionIndex).join('\n')
    };
}

function isCompletedTwin(backchannelRecord: AppHostLoggerRecord, pendingRecord: AppHostLoggerRecord): boolean {
    // Deliberately stricter than areEquivalentRecords, which treats a missing exception as a
    // wildcard so the two sources still correlate once both are whole. A record that is still
    // being assembled matches that wildcard as soon as its first line lands, so using it here
    // would cut the exception off the record it belongs to.
    return backchannelRecord.categoryName === pendingRecord.categoryName
        && backchannelRecord.logLevel === pendingRecord.logLevel
        && backchannelRecord.message === pendingRecord.message
        && backchannelRecord.exception === pendingRecord.exception;
}

function areEquivalentRecords(left: AppHostLoggerRecord, right: AppHostLoggerRecord): boolean {
    if (left.categoryName !== right.categoryName || left.logLevel !== right.logLevel) {
        return false;
    }

    // DebugLogger omits the event id entirely, so an absent value on either side is a
    // wildcard rather than a mismatch.
    if (left.eventId !== undefined && right.eventId !== undefined && left.eventId !== right.eventId) {
        return false;
    }

    if (left.exception !== undefined && right.exception !== undefined) {
        return left.message === right.message && left.exception === right.exception;
    }

    // Only one side separated an exception from the message, which happens in two ways:
    //
    //   1. The AppHost predates BackchannelLogEntry.Exception. Its structured message is
    //      `formatter(state, exception)`, which drops the exception, while the console
    //      copy still prints it. The formatted messages match.
    //   2. A multi-line message whose continuation happens to look like an exception,
    //      e.g. "Retry failed.\nSystem.TimeoutException: timed out" passed as a single
    //      message. The console copy splits it; the structured copy does not. The
    //      recombined bodies match.
    //
    // Accepting either keeps both cases correlated instead of rendering them twice.
    return left.message === right.message || getRecordBody(left) === getRecordBody(right);
}

function getRecordBody(record: AppHostLoggerRecord): string {
    return record.exception ? `${record.message}\n${record.exception}` : record.message;
}

// Standard SGR codes, resolved through the workbench ANSI palette so the rendered
// record follows the active color theme.
function formatLoggerRecord(record: AppHostLoggerRecord): AppHostParentOutput {
    const body = `${record.categoryName}: ${record.logLevel}: ${record.message}${record.exception ? `\n${record.exception}` : ''}`;
    const category = record.logLevel === 'Error' || record.logLevel === 'Critical' ? 'stderr' : 'stdout';
    const style = record.logLevel === 'Trace' || record.logLevel === 'Debug'
        ? AnsiColors.Dim
        : record.logLevel === 'Warning'
            ? AnsiColors.Yellow
            : undefined;

    return {
        // Every rendered record carries its own terminator. The debug console appends
        // output verbatim, so an unterminated record would run into the next one. The
        // ANSI reset stays inside the line so the newline is not styled.
        output: `${applyTextStyle(body, style)}\n`,
        category
    };
}

function normalizeOptionalRecordText(value: string | null | undefined): string | undefined {
    return value ? normalizeRecordText(value) : undefined;
}

function normalizeRecordText(value: string): string {
    // Trailing padding differs per source. SimpleConsoleFormatter indents every
    // continuation line, so `logger.LogInformation("text\n")` arrives on the console as
    // an extra padded line while the backchannel copy keeps a bare newline. Trimming
    // trailing whitespace makes the two comparable and does not change how a record
    // reads.
    return escapeConsoleControlCharacters(normalizeLineEndings(value)).replace(/[ \t\n]+$/, '');
}

function escapeConsoleControlCharacters(value: string): string {
    // The console formatters escape C0, DEL and C1 as \uXXXX before writing, keeping only
    // \t \n \r, so a message carrying a raw ESC reaches the console escaped while the
    // backchannel copy keeps it raw and the two stop correlating. Applying the same rule to
    // every source is stable in both directions: an already-escaped copy has no control
    // characters left to escape, and a raw copy ends up spelled the same way.
    //
    // https://github.com/dotnet/runtime/pull/128741 added the sanitizer, which is not in
    // release/10.0, so today this only ever fires on a message that both sources carry raw.
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, character =>
        `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n|\r/g, '\n');
}

function removeSingleTrailingNewline(value: string): string {
    return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function getFullLoggerLevel(shortLevel: string): AppHostLogLevel {
    switch (shortLevel) {
        case 'trce':
            return 'Trace';
        case 'dbug':
            return 'Debug';
        case 'info':
            return 'Information';
        case 'warn':
            return 'Warning';
        case 'fail':
            return 'Error';
        case 'crit':
            return 'Critical';
        default:
            throw new Error(`Unknown logger level: ${shortLevel}`);
    }
}

function getConsoleLogSeverity(line: string): 'low' | 'normal' | 'severe' | undefined {
    const defaultConsoleLogLevel = /^(trce|dbug|info|warn|fail|crit):\s/.exec(line)?.[1];
    if (defaultConsoleLogLevel) {
        return defaultConsoleLogLevel === 'trce' || defaultConsoleLogLevel === 'dbug'
            ? 'low'
            : defaultConsoleLogLevel === 'fail' || defaultConsoleLogLevel === 'crit'
                ? 'severe'
                : 'normal';
    }

    // Real category names are namespaced .NET type names. Requiring a dot avoids
    // treating arbitrary stdout such as "Status: Error: connection refused" as a log.
    const simpleConsoleLogLevel = /^[A-Za-z_]\w*(?:\.\w+)+(?:\[[^\]]+\])?:\s*(Trace|Debug|Information|Warning|Error|Critical):\s/.exec(line)?.[1];
    if (simpleConsoleLogLevel) {
        return simpleConsoleLogLevel === 'Trace' || simpleConsoleLogLevel === 'Debug'
            ? 'low'
            : simpleConsoleLogLevel === 'Error' || simpleConsoleLogLevel === 'Critical'
                ? 'severe'
                : 'normal';
    }

    return undefined;
}

function isIndentedContinuation(line: string): boolean {
    return /^\s+\S/.test(line);
}

function isSevereRuntimeOutputLine(line: string): boolean {
    return /(?:^|\s)(?:[A-Za-z_][\w`]*\.)+(?:[A-Za-z_][\w`]*Exception|Exception):/.test(line)
        || /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*Error|Error)(?:\s+\[[^\]]+\])?:/.test(line)
        || /^(?:fatal|critical|panic|aborted|segmentation\s+fault|unhandled\s+exception)\b/i.test(line);
}

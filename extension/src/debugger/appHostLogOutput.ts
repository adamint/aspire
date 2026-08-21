import { applyTextStyle } from '../utils/strings';

const enum AnsiColors {
    Dim = '\x1b[2m',
    Yellow = '\x1b[33m',
}

export type AppHostLogLevel = 'Trace' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Critical';

export interface AppHostLogEntry {
    sequenceNumber: number;
    logLevel: AppHostLogLevel;
    message: string;
    categoryName: string;
    eventId: number;
    exception?: string | null;
}

export interface AppHostParentOutput {
    output: string;
    category: 'stdout' | 'stderr';
}

type LogSource = 'backchannel' | 'consoleLogger' | 'debugLogger';

interface LogRecord {
    categoryName: string;
    logLevel: AppHostLogLevel;
    eventId?: number;
    body: string;
    singleLine?: boolean;
}

interface CorrelatedRecord {
    record: LogRecord;
    sources: Set<LogSource>;
}

interface PendingConsoleRecord {
    record: Omit<LogRecord, 'body'>;
    body: string;
    bodyWithoutLeadingScopes: string;
    raw: string;
    category: string;
    allowsContinuation: boolean;
    hasBodyLine: boolean;
    hasNonScopeBodyLine: boolean;
}

interface PendingDebugRecord {
    raw: string;
    category: string;
}

export class AppHostLogOutputCoordinator {
    private static readonly _maxCorrelatedRecords = 1024;
    private static readonly _maxLowLevelCorrelatedRecords = 128;
    private static readonly _allSources: readonly LogSource[] = ['backchannel', 'consoleLogger', 'debugLogger'];
    private static readonly _lowLevelSources: readonly LogSource[] = ['consoleLogger', 'debugLogger'];
    private static readonly _maxRememberedBackchannelSequences = 1024;
    private static readonly _idleFlushDelayMs = 250;

    private readonly _correlatedRecords: CorrelatedRecord[] = [];
    private readonly _lowLevelCorrelatedRecords: CorrelatedRecord[] = [];
    private readonly _backchannelSequences = new Set<number>();
    private readonly _backchannelSequenceOrder: number[] = [];
    private readonly _partialLines = new Map<string, string>();
    private readonly _pendingRecords = new Map<string, PendingConsoleRecord>();
    private readonly _pendingDebugRecords = new Map<string, PendingDebugRecord>();
    private readonly _fallbackFilters = new Map<string, AppHostParentOutputFilter>();
    private readonly _idleFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly _onIdleFlush?: (output: AppHostParentOutput) => void,
        private readonly _idleFlushDelayMs = AppHostLogOutputCoordinator._idleFlushDelayMs) {
    }

    handleBackchannelEntry(entry: AppHostLogEntry): AppHostParentOutput | undefined {
        if (entry.sequenceNumber > 0) {
            // A reconnect replays the AppHost's 1,000-entry buffer. Remember exact sequences
            // instead of a high-water mark so delayed delivery cannot discard an unseen record.
            if (this._backchannelSequences.has(entry.sequenceNumber)) {
                return undefined;
            }

            this._backchannelSequences.add(entry.sequenceNumber);
            this._backchannelSequenceOrder.push(entry.sequenceNumber);
            if (this._backchannelSequenceOrder.length > AppHostLogOutputCoordinator._maxRememberedBackchannelSequences) {
                this._backchannelSequences.delete(this._backchannelSequenceOrder.shift()!);
            }
        }

        const record = createBackchannelRecord(entry);

        return this.correlate(record, 'backchannel');
    }

    handleDebugAdapterOutput(output: string, category: string | undefined): AppHostParentOutput[] {
        const normalizedCategory = category ?? 'console';
        const outputs: AppHostParentOutput[] = [];

        const buffered = `${this._partialLines.get(normalizedCategory) ?? ''}${output}`;
        const lastBreak = findLastCompletedLineBreak(buffered);
        const completed = buffered.slice(0, lastBreak + 1);
        const partial = buffered.slice(lastBreak + 1);

        for (const line of completed.match(/[^\r\n]*(?:\r\n|\r|\n)/g) ?? []) {
            this.consumeLine(line, normalizedCategory, outputs);
        }

        if (partial) {
            this._partialLines.set(normalizedCategory, partial);
        } else {
            this._partialLines.delete(normalizedCategory);
        }

        this.scheduleIdleFlush(normalizedCategory);

        return outputs;
    }

    flush(): AppHostParentOutput[] {
        this.clearIdleFlushTimers();

        const outputs: AppHostParentOutput[] = [];
        const partials = [...this._partialLines];
        this._partialLines.clear();

        for (const [category, partial] of partials) {
            this.consumeLine(partial, category, outputs);
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
        this.clearIdleFlushTimers();
        this._correlatedRecords.length = 0;
        this._lowLevelCorrelatedRecords.length = 0;
        this._backchannelSequences.clear();
        this._backchannelSequenceOrder.length = 0;
        this._partialLines.clear();
        this._pendingRecords.clear();
        this._pendingDebugRecords.clear();
        this._fallbackFilters.clear();
    }

    private consumeLine(line: string, category: string, outputs: AppHostParentOutput[]): void {
        if (category === 'console' && this.consumeDebugLoggerLine(line, category, outputs)) {
            return;
        }

        const pending = this._pendingRecords.get(category);
        if (pending) {
            const hasConsoleIndentation = isConsoleLoggerContinuation(line);
            if (pending.allowsContinuation && (hasConsoleIndentation || isWindowsBareLfContinuation(pending))) {
                pending.raw += line;
                const bodyLine = hasConsoleIndentation
                    ? removeConsoleIndentation(line)
                    : normalizeConsoleLine(line);
                // IncludeScopes writes leading lines such as:
                //   => RequestPath:/health => ConnectionId:0HN...
                // Keep them until correlation can distinguish scope metadata from a real message
                // such as `logger.LogInformation("=> started")`.
                pending.body += bodyLine;
                if (pending.hasNonScopeBodyLine || !bodyLine.startsWith('=> ')) {
                    pending.bodyWithoutLeadingScopes += bodyLine;
                    pending.hasNonScopeBodyLine = true;
                }
                pending.hasBodyLine = true;
                return;
            }

            this.flushPendingRecord(category, outputs);
        }

        const multilineHeader = parseMultilineConsoleLoggerHeader(line);
        if (multilineHeader && category !== 'console') {
            this._pendingRecords.set(category, {
                record: multilineHeader,
                body: '',
                bodyWithoutLeadingScopes: '',
                raw: line,
                category,
                allowsContinuation: true,
                hasBodyLine: false,
                hasNonScopeBodyLine: false
            });
            return;
        }

        const singleLineRecord = parseSingleLineConsoleLoggerRecord(line);
        if (singleLineRecord && category !== 'console') {
            this._pendingRecords.set(category, {
                record: {
                    categoryName: singleLineRecord.categoryName,
                    logLevel: singleLineRecord.logLevel,
                    eventId: singleLineRecord.eventId,
                    singleLine: true
                },
                body: singleLineRecord.body,
                bodyWithoutLeadingScopes: singleLineRecord.body,
                raw: line,
                category,
                allowsContinuation: false,
                hasBodyLine: true,
                hasNonScopeBodyLine: true
            });
            return;
        }

        this.emitFallback(line, category, outputs);
    }

    private flushPendingRecord(category: string, outputs: AppHostParentOutput[]): void {
        const pending = this._pendingRecords.get(category);
        if (!pending) {
            return;
        }

        this._pendingRecords.delete(category);

        const candidates = createPendingRecords(pending);
        const record = candidates.find(candidate => this.hasCorrelatedTwin(candidate, 'consoleLogger'))
            ?? candidates[0];

        const output = this.correlate(record, 'consoleLogger');
        if (output) {
            outputs.push(output);
        }
    }

    private consumeDebugLoggerLine(
        line: string,
        category: string,
        outputs: AppHostParentOutput[]): boolean {
        const pending = this._pendingDebugRecords.get(category);
        if (pending) {
            if (isDebugLoggerHeader(line)) {
                if (this.continuesPendingDebugRecord(pending, line)) {
                    pending.raw += line;
                    return true;
                }

                this.flushPendingDebugRecord(category, outputs);
                this._pendingDebugRecords.set(category, { raw: line, category });
                return true;
            }

            if (startsUnrelatedDebuggerOutput(line)
                || (!isDebugLoggerContinuation(line)
                    && !this.continuesPendingDebugRecord(pending, line))) {
                this.flushPendingDebugRecord(category, outputs);
                return false;
            }

            pending.raw += line;
            return true;
        }

        if (!isDebugLoggerHeader(line)) {
            return false;
        }

        this._pendingDebugRecords.set(category, { raw: line, category });
        return true;
    }

    private continuesPendingDebugRecord(pending: PendingDebugRecord, line: string): boolean {
        const merged = parseDebugLoggerRecord(`${pending.raw}${line}`);
        return !!merged && this.hasCorrelatedTwin(merged, 'debugLogger');
    }

    private flushPendingDebugRecord(category: string, outputs: AppHostParentOutput[]): void {
        const pending = this._pendingDebugRecords.get(category);
        if (!pending) {
            return;
        }

        this._pendingDebugRecords.delete(category);

        const record = parseDebugLoggerRecord(pending.raw);
        if (!record) {
            this.emitFallback(pending.raw, pending.category, outputs);
            return;
        }

        const output = this.correlate(record, 'debugLogger');
        if (output) {
            outputs.push(output);
        }
    }

    private correlate(record: LogRecord, source: LogSource): AppHostParentOutput | undefined {
        const records = this.correlatedRecordsFor(record);
        const index = records.findIndex(candidate =>
            !candidate.sources.has(source) && recordsMatch(candidate.record, record));
        if (index < 0) {
            records.push({ record, sources: new Set([source]) });
            const limit = isLowLevel(record)
                ? AppHostLogOutputCoordinator._maxLowLevelCorrelatedRecords
                : AppHostLogOutputCoordinator._maxCorrelatedRecords;
            if (records.length > limit) {
                records.shift();
            }

            return formatLogRecord(record);
        }

        const existing = records[index];
        existing.sources.add(source);
        const expectedSources = isLowLevel(record)
            ? AppHostLogOutputCoordinator._lowLevelSources
            : AppHostLogOutputCoordinator._allSources;
        if (expectedSources.every(expectedSource => existing.sources.has(expectedSource))) {
            records.splice(index, 1);
        }

        return undefined;
    }

    private hasCorrelatedTwin(record: LogRecord, source: LogSource): boolean {
        return this.correlatedRecordsFor(record).some(candidate =>
            !candidate.sources.has(source) && recordsMatch(candidate.record, record));
    }

    private correlatedRecordsFor(record: LogRecord): CorrelatedRecord[] {
        // Trace and Debug are not sent over the structured CLI backchannel. Keep their
        // adapter-only correlation history separate so a noisy low-level stream cannot
        // evict Information+ records that are still waiting for another provider copy.
        return isLowLevel(record) ? this._lowLevelCorrelatedRecords : this._correlatedRecords;
    }

    private emitFallback(output: string, category: string, outputs: AppHostParentOutput[]): void {
        const filtered = this.fallbackFilterFor(category).filter(output, category);
        if (filtered) {
            outputs.push(filtered);
        }
    }

    private fallbackFilterFor(category: string): AppHostParentOutputFilter {
        let filter = this._fallbackFilters.get(category);
        if (!filter) {
            filter = new AppHostParentOutputFilter();
            this._fallbackFilters.set(category, filter);
        }

        return filter;
    }

    private scheduleIdleFlush(category: string): void {
        const pending = this._pendingRecords.get(category);
        const hasPendingDebugRecord = this._pendingDebugRecords.has(category);
        if (!this._onIdleFlush || (!pending?.hasBodyLine && !hasPendingDebugRecord && !this._partialLines.has(category))) {
            this.clearIdleFlushTimer(category);
            return;
        }

        // Keep the deadline established by the first pending chunk. Restarting the timer
        // for every chunk can hide a continuously written partial line and grow it forever.
        if (this._idleFlushTimers.has(category)) {
            return;
        }

        const timer = setTimeout(() => {
            this._idleFlushTimers.delete(category);
            const outputs: AppHostParentOutput[] = [];

            const partial = this._partialLines.get(category);
            if (partial) {
                this._partialLines.delete(category);
                this.consumeLine(partial, category, outputs);
            }

            this.flushPendingRecord(category, outputs);
            this.flushPendingDebugRecord(category, outputs);
            outputs.forEach(output => this._onIdleFlush?.(output));
        }, this._idleFlushDelayMs);

        this._idleFlushTimers.set(category, timer);
    }

    private clearIdleFlushTimer(category: string): void {
        const timer = this._idleFlushTimers.get(category);
        if (timer) {
            clearTimeout(timer);
            this._idleFlushTimers.delete(category);
        }
    }

    private clearIdleFlushTimers(): void {
        for (const timer of this._idleFlushTimers.values()) {
            clearTimeout(timer);
        }
        this._idleFlushTimers.clear();
    }
}

export class AppHostParentOutputFilter {
    private _continuingDroppedLog = false;
    private _continuingErrorBlock = false;
    private _lastCategory: string | undefined;

    filter(output: string, category: string | undefined): AppHostParentOutput | undefined {
        const normalizedCategory = category ?? 'console';
        if (normalizedCategory === 'debug') {
            this.reset();
            this._lastCategory = normalizedCategory;
            return undefined;
        }

        if (normalizedCategory !== this._lastCategory) {
            this.reset();
        }
        this._lastCategory = normalizedCategory;

        const segments = output.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(segment => segment) ?? [];
        let filteredOutput = '';
        let hasErrorOutput = normalizedCategory === 'stderr';

        for (const segment of segments) {
            const outputCategory = this.getLineCategory(segment, normalizedCategory);
            if (outputCategory) {
                filteredOutput += segment;
                hasErrorOutput ||= outputCategory === 'stderr';
            }
        }

        return filteredOutput
            ? { output: filteredOutput, category: hasErrorOutput ? 'stderr' : 'stdout' }
            : undefined;
    }

    private getLineCategory(segment: string, category: string): 'stdout' | 'stderr' | undefined {
        const line = segment.replace(/(?:\r\n|\r|\n)$/, '');
        const trimmedLine = line.trim();

        if (!trimmedLine) {
            return !this._continuingDroppedLog && (category !== 'console' || this._continuingErrorBlock)
                ? this.getCurrentCategory(category)
                : undefined;
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

        const severe = isSevereRuntimeOutputLine(trimmedLine);
        this._continuingDroppedLog = false;
        this._continuingErrorBlock = severe;

        return category === 'console' && !severe
            ? undefined
            : this.getCurrentCategory(category);
    }

    private getCurrentCategory(category: string): 'stdout' | 'stderr' {
        return category === 'stderr' || this._continuingErrorBlock ? 'stderr' : 'stdout';
    }

    private reset(): void {
        this._continuingDroppedLog = false;
        this._continuingErrorBlock = false;
    }
}

function createBackchannelRecord(entry: AppHostLogEntry): LogRecord {
    return {
        categoryName: escapeCategoryControlCharacters(entry.categoryName),
        logLevel: entry.logLevel,
        eventId: entry.eventId,
        body: normalizeRecordText(joinRecordBody(entry.message, entry.exception))
    };
}

function createPendingRecords(pending: PendingConsoleRecord): LogRecord[] {
    const fullBodyRecord = {
        ...pending.record,
        body: normalizeRecordText(pending.body)
    };
    const bodyWithoutLeadingScopes = normalizeRecordText(pending.bodyWithoutLeadingScopes);

    return bodyWithoutLeadingScopes === fullBodyRecord.body
        ? [fullBodyRecord]
        : [fullBodyRecord, { ...pending.record, body: bodyWithoutLeadingScopes }];
}

const consoleLoggerTimestampPrefix =
    String.raw`(?:(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+)?`;
const multilineConsoleLoggerHeaderRegex = new RegExp(
    String.raw`^${consoleLoggerTimestampPrefix}(trce|dbug|info|warn|fail|crit): (.*)\[(-?\d+)\](?:\r\n|\r|\n)$`);
const singleLineConsoleLoggerRecordRegex = new RegExp(
    String.raw`^${consoleLoggerTimestampPrefix}(trce|dbug|info|warn|fail|crit): (.*?)\[(-?\d+)\] (.*?)(?:\r\n|\r|\n)?$`);
const debugLoggerCategoryPattern = String.raw`[A-Za-z_]\w*(?:\.\w+)+`;
const debugLoggerRecordRegex = new RegExp(
    String.raw`^(${debugLoggerCategoryPattern})(?:\[(-?\d+)\])?: (Trace|Debug|Information|Warning|Error|Critical): ([\s\S]*)$`);
const debugLoggerHeaderRegex = new RegExp(
    String.raw`^${debugLoggerCategoryPattern}(?:\[-?\d+\])?: (Trace|Debug|Information|Warning|Error|Critical): .*(?:\r\n|\r|\n)?$`);

function parseMultilineConsoleLoggerHeader(line: string): Omit<LogRecord, 'body'> | undefined {
    // SimpleConsoleFormatter's default multiline record begins as:
    //   warn: Example.Category[7]
    //         First message line.
    // Common date/time prefixes are accepted, but arbitrary text before "warn:" is not:
    // otherwise a user line such as "status warn: ..." becomes a false log record.
    const match = multilineConsoleLoggerHeaderRegex.exec(line);
    if (!match) {
        return undefined;
    }

    return {
        categoryName: escapeCategoryControlCharacters(match[2]),
        logLevel: getFullLoggerLevel(match[1]),
        eventId: Number(match[3])
    };
}

function parseSingleLineConsoleLoggerRecord(line: string): LogRecord | undefined {
    // With SimpleConsoleFormatterOptions.SingleLine, the same record is:
    //   warn: Example.Category[7] First message line.
    const match = singleLineConsoleLoggerRecordRegex.exec(line);
    if (!match) {
        return undefined;
    }

    return {
        categoryName: escapeCategoryControlCharacters(match[2]),
        logLevel: getFullLoggerLevel(match[1]),
        eventId: Number(match[3]),
        body: normalizeRecordText(match[4]),
        singleLine: true
    };
}

function parseDebugLoggerRecord(output: string): LogRecord | undefined {
    // DebugLogger writes:
    //   Example.Category: Warning: Deployment failed.
    //
    //   System.InvalidOperationException: boom
    // It doesn't include the event ID, so correlation treats a missing ID as a wildcard
    // while still requiring category, level, and the complete normalized body to match.
    const normalized = normalizeRecordText(output.replace(/(?:\r\n|\r|\n)$/, ''));
    const match = debugLoggerRecordRegex.exec(normalized);
    if (!match) {
        return undefined;
    }

    const { message, exception } = splitMessageAndException(match[4]);
    return {
        categoryName: escapeCategoryControlCharacters(match[1]),
        logLevel: match[3] as AppHostLogLevel,
        eventId: match[2] === undefined ? undefined : Number(match[2]),
        body: normalizeRecordText(joinRecordBody(message, exception))
    };
}

function isDebugLoggerHeader(line: string): boolean {
    return debugLoggerHeaderRegex.test(line);
}

function isDebugLoggerContinuation(line: string): boolean {
    const content = line.replace(/(?:\r\n|\r|\n)$/, '');
    const trimmedLine = content.trim();

    // DebugLogger continuation lines are ambiguous with arbitrary Debug.WriteLine output.
    // Continue only shapes that are part of an exception or visibly indented so an unrelated
    // console line cannot change the pending record's correlation identity.
    return !content
        || /^\s/.test(content)
        || isDebugLoggerExceptionStart(trimmedLine)
        || /^---> /.test(trimmedLine)
        || /^--- End of /.test(trimmedLine);
}

function startsUnrelatedDebuggerOutput(line: string): boolean {
    // DebugLogger continuation lines have no prefix, so only break on conservative,
    // debugger-owned shapes. Absorbing these lines would alter correlation identity and
    // could hide a fatal runtime line behind the preceding log record.
    const trimmedLine = line.trim();
    return /^Unhandled exception\./.test(trimmedLine)
        || /^(?:'[^']*' \([^)]*\): |\S+ \(\d+\): )?Loaded '[^']*'\./.test(trimmedLine)
        || /^Exception thrown: '/.test(trimmedLine)
        || /^-{5,}$/.test(trimmedLine);
}

function splitMessageAndException(value: string): { message: string; exception?: string } {
    const lines = value.replace(/\r\n|\r/g, '\n').split('\n');
    const exceptionIndex = lines.findIndex((line, index) =>
        index > 0 && lines[index - 1] === '' && isDebugLoggerExceptionStart(line));
    if (exceptionIndex < 0) {
        return { message: value };
    }

    return {
        message: lines.slice(0, exceptionIndex - 1).join('\n'),
        exception: lines.slice(exceptionIndex).join('\n')
    };
}

function isDebugLoggerExceptionStart(line: string): boolean {
    return /^(?:[A-Za-z_][\w`]*(?:\.[A-Za-z_][\w`]*)*(?:Exception|Error)(?: \([^)]*\))?:|Unhandled exception\.)/.test(line);
}

function isConsoleLoggerContinuation(line: string): boolean {
    const content = line.replace(/(?:\r\n|\r|\n)$/, '');
    return content.startsWith('      ');
}

function isWindowsBareLfContinuation(pending: PendingConsoleRecord): boolean {
    // On Windows SimpleConsoleFormatter only indents Environment.NewLine (`\r\n`).
    // A bare LF embedded in the message therefore leaves the following line unindented.
    return pending.raw.includes('\r\n')
        && pending.raw.endsWith('\n')
        && !pending.raw.endsWith('\r\n');
}

function removeConsoleIndentation(line: string): string {
    return line.slice(6).replace(/\r\n|\r/g, '\n');
}

function normalizeConsoleLine(line: string): string {
    return line.replace(/\r\n|\r/g, '\n');
}

function findLastCompletedLineBreak(text: string): number {
    // A Windows CRLF can be split between two DAP events. A trailing lone CR is therefore
    // incomplete until the next event supplies LF or the session flushes.
    const searchable = text.endsWith('\r') ? text.slice(0, -1) : text;
    return Math.max(searchable.lastIndexOf('\n'), searchable.lastIndexOf('\r'));
}

function recordsMatch(left: LogRecord, right: LogRecord): boolean {
    return left.categoryName === right.categoryName
        && left.logLevel === right.logLevel
        && (left.eventId === undefined || right.eventId === undefined || left.eventId === right.eventId)
        && (left.body === right.body
            || !!(left.singleLine || right.singleLine)
                && toSingleLineRecordText(left.body) === toSingleLineRecordText(right.body));
}

function isLowLevel(record: LogRecord): boolean {
    return record.logLevel === 'Trace' || record.logLevel === 'Debug';
}

function toSingleLineRecordText(value: string): string {
    return value.replace(/\r\n|\r|\n/g, ' ');
}

function formatLogRecord(record: LogRecord): AppHostParentOutput {
    const prefix = record.categoryName
        ? `${record.categoryName}: ${record.logLevel}`
        : record.logLevel;
    const raw = `${prefix}: ${record.body}`;
    return formatRecord(raw, record.logLevel, record.logLevel === 'Error' || record.logLevel === 'Critical' ? 'stderr' : 'stdout');
}

function formatRecord(raw: string, logLevel: AppHostLogLevel, category: 'stdout' | 'stderr'): AppHostParentOutput {
    const style = logLevel === 'Trace' || logLevel === 'Debug'
        ? AnsiColors.Dim
        : logLevel === 'Warning'
            ? AnsiColors.Yellow
            : undefined;

    return {
        output: `${applyTextStyle(raw, style)}\n`,
        category
    };
}

function normalizeRecordText(value: string): string {
    return value.replace(/\r\n|\r/g, '\n').replace(/[ \t\n]+$/, '');
}

function joinRecordBody(message: string, exception?: string | null): string {
    return [message, exception]
        .filter((part): part is string => !!part)
        .join('\n');
}

function escapeCategoryControlCharacters(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function getFullLoggerLevel(shortLevel: string): AppHostLogLevel {
    switch (shortLevel) {
        case 'trce': return 'Trace';
        case 'dbug': return 'Debug';
        case 'info': return 'Information';
        case 'warn': return 'Warning';
        case 'fail': return 'Error';
        case 'crit': return 'Critical';
        default: throw new Error(`Unknown logger level: ${shortLevel}`);
    }
}

function getConsoleLogSeverity(line: string): 'low' | 'normal' | 'severe' | undefined {
    const level = /^(trce|dbug|info|warn|fail|crit):\s/.exec(line)?.[1];
    if (level) {
        return level === 'trce' || level === 'dbug'
            ? 'low'
            : level === 'fail' || level === 'crit'
                ? 'severe'
                : 'normal';
    }

    // Preserve the pre-correlation filter for adapters that render records as:
    //   Example.Category[7]: Warning: Request took too long.
    // These records cannot be correlated with the default console grammar, but their
    // low-level suppression and severe-stream classification must remain unchanged.
    const fullLevel = /^[A-Za-z_]\w*(?:\.\w+)+(?:\[[^\]]+\])?:\s*(Trace|Debug|Information|Warning|Error|Critical):\s/.exec(line)?.[1];
    return fullLevel === 'Trace' || fullLevel === 'Debug'
        ? 'low'
        : fullLevel === 'Error' || fullLevel === 'Critical'
            ? 'severe'
            : fullLevel
                ? 'normal'
                : undefined;
}

function isIndentedContinuation(line: string): boolean {
    return /^\s+\S/.test(line);
}

function isSevereRuntimeOutputLine(line: string): boolean {
    return /(?:^|\s)(?:[A-Za-z_][\w`]*\.)+(?:[A-Za-z_][\w`]*Exception|Exception):/.test(line)
        || /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*Error|Error)(?:\s+\[[^\]]+\])?:/.test(line)
        || /^(?:fatal|critical|panic|aborted|segmentation\s+fault|unhandled\s+exception)\b/i.test(line);
}

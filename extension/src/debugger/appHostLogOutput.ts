import { AnsiColors } from '../utils/AspireTerminalProvider';
import { applyTextStyle } from '../utils/strings';

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

type LogSource = 'backchannel' | 'console';

interface LogRecord {
    categoryName: string;
    logLevel: AppHostLogLevel;
    eventId: number;
    body: string;
    singleLine?: boolean;
}

interface CorrelatedRecord {
    record: LogRecord;
    source: LogSource;
}

interface PendingConsoleRecord {
    record: Omit<LogRecord, 'body'>;
    body: string;
    raw: string;
    category: string;
    allowsContinuation: boolean;
}

export class AppHostLogOutputCoordinator {
    private static readonly _maxCorrelatedRecords = 1024;
    private static readonly _maxRememberedBackchannelSequences = 1024;
    private static readonly _idleFlushDelayMs = 250;

    private readonly _correlatedRecords: CorrelatedRecord[] = [];
    private readonly _backchannelSequences = new Set<number>();
    private readonly _backchannelSequenceOrder: number[] = [];
    private readonly _partialLines = new Map<string, string>();
    private readonly _pendingRecords = new Map<string, PendingConsoleRecord>();
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

        for (const [category, pending] of this._pendingRecords) {
            const pendingRecord = createPendingRecord(pending);
            if (pendingRecord && recordsMatch(pendingRecord, record)) {
                this.deletePendingRecord(category);
                return formatConsoleRecord(record, pending.raw, pending.category);
            }
        }

        return this.correlate(record, 'backchannel', formatBackchannelRecord(record));
    }

    handleDebugAdapterOutput(output: string, category: string | undefined): AppHostParentOutput[] {
        const normalizedCategory = category ?? 'console';
        const outputs: AppHostParentOutput[] = [];
        this.clearIdleFlushTimer(normalizedCategory);

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

        return outputs;
    }

    reset(): void {
        this.clearIdleFlushTimers();
        this._correlatedRecords.length = 0;
        this._backchannelSequences.clear();
        this._backchannelSequenceOrder.length = 0;
        this._partialLines.clear();
        this._pendingRecords.clear();
        this._fallbackFilters.clear();
    }

    private consumeLine(line: string, category: string, outputs: AppHostParentOutput[]): void {
        const pending = this._pendingRecords.get(category);
        if (pending) {
            if (pending.allowsContinuation && isConsoleLoggerContinuation(line)) {
                pending.raw += line;
                const bodyLine = removeConsoleIndentation(line);
                // IncludeScopes writes leading lines such as:
                //   => RequestPath:/health => ConnectionId:0HN...
                // They are provider-only metadata, so exclude them from correlation identity.
                if (pending.body || !bodyLine.startsWith('=> ')) {
                    pending.body += bodyLine;
                }

                const record = createPendingRecord(pending);
                if (record && this.consumeCorrelatedRecord(record, 'console')) {
                    this.deletePendingRecord(category);
                }
                return;
            }

            this.flushPendingRecord(category, outputs);
        }

        const multilineHeader = parseMultilineConsoleLoggerHeader(line);
        if (multilineHeader && category !== 'console') {
            this._pendingRecords.set(category, {
                record: multilineHeader,
                body: '',
                raw: line,
                category,
                allowsContinuation: true
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
                raw: line,
                category,
                allowsContinuation: false
            });

            if (this.consumeCorrelatedRecord(singleLineRecord, 'console')) {
                this.deletePendingRecord(category);
            }
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

        const record = createPendingRecord(pending);
        if (!record) {
            this.emitFallback(pending.raw, pending.category, outputs);
            return;
        }

        const output = this.correlate(record, 'console', formatConsoleRecord(record, pending.raw, pending.category));
        if (output) {
            outputs.push(output);
        }
    }

    private correlate(record: LogRecord, source: LogSource, output: AppHostParentOutput): AppHostParentOutput | undefined {
        if (this.consumeCorrelatedRecord(record, source)) {
            return undefined;
        }

        this._correlatedRecords.push({ record, source });
        if (this._correlatedRecords.length > AppHostLogOutputCoordinator._maxCorrelatedRecords) {
            this._correlatedRecords.shift();
        }

        return output;
    }

    private consumeCorrelatedRecord(record: LogRecord, source: LogSource): boolean {
        const index = this._correlatedRecords.findIndex(candidate =>
            candidate.source !== source && recordsMatch(candidate.record, record));
        if (index < 0) {
            return false;
        }

        this._correlatedRecords.splice(index, 1);
        return true;
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
        if (!this._onIdleFlush || (!pending?.body && !this._partialLines.has(category))) {
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
            outputs.forEach(output => this._onIdleFlush?.(output));
        }, this._idleFlushDelayMs);

        this._idleFlushTimers.set(category, timer);
    }

    private deletePendingRecord(category: string): void {
        this._pendingRecords.delete(category);
        this.clearIdleFlushTimer(category);
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

    filter(output: string, category: string | undefined): AppHostParentOutput | undefined {
        const normalizedCategory = category ?? 'console';
        if (normalizedCategory === 'debug') {
            this.reset();
            return undefined;
        }

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
            return !this._continuingDroppedLog && category !== 'console'
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
        categoryName: entry.categoryName,
        logLevel: entry.logLevel,
        eventId: entry.eventId,
        body: normalizeRecordText(entry.exception
            ? `${entry.message}\n${entry.exception}`
            : entry.message)
    };
}

function createPendingRecord(pending: PendingConsoleRecord): LogRecord | undefined {
    if (!pending.body) {
        return undefined;
    }

    return {
        ...pending.record,
        body: normalizeRecordText(pending.body)
    };
}

function parseMultilineConsoleLoggerHeader(line: string): Omit<LogRecord, 'body'> | undefined {
    // SimpleConsoleFormatter's default multiline record begins as:
    //   warn: Example.Category[7]
    //         First message line.
    // The category may be empty, and DAP chunks can split anywhere within either line.
    const match = /^(?:.*\s)?(trce|dbug|info|warn|fail|crit): (.*)\[(-?\d+)\](?:\r\n|\r|\n)$/.exec(line);
    if (!match) {
        return undefined;
    }

    return {
        categoryName: match[2],
        logLevel: getFullLoggerLevel(match[1]),
        eventId: Number(match[3])
    };
}

function parseSingleLineConsoleLoggerRecord(line: string): LogRecord | undefined {
    // With SimpleConsoleFormatterOptions.SingleLine, the same record is:
    //   warn: Example.Category[7] First message line.
    const match = /^(?:.*\s)?(trce|dbug|info|warn|fail|crit): (.*)\[(-?\d+)\] (.*?)(?:\r\n|\r|\n)?$/.exec(line);
    if (!match) {
        return undefined;
    }

    return {
        categoryName: match[2],
        logLevel: getFullLoggerLevel(match[1]),
        eventId: Number(match[3]),
        body: normalizeRecordText(match[4]),
        singleLine: true
    };
}

function isConsoleLoggerContinuation(line: string): boolean {
    const content = line.replace(/(?:\r\n|\r|\n)$/, '');
    return content.startsWith('      ');
}

function removeConsoleIndentation(line: string): string {
    return line.slice(6).replace(/\r\n|\r/g, '\n');
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
        && left.eventId === right.eventId
        && (left.body === right.body
            || !!(left.singleLine || right.singleLine)
                && toSingleLineRecordText(left.body) === toSingleLineRecordText(right.body));
}

function toSingleLineRecordText(value: string): string {
    return value.replace(/\r\n|\r|\n/g, ' ');
}

function formatBackchannelRecord(record: LogRecord): AppHostParentOutput {
    const token = getShortLoggerLevel(record.logLevel);
    const lines = record.body.split('\n').map(line => `      ${line}`).join('\n');
    const raw = `${token}: ${record.categoryName}[${record.eventId}]\n${lines}`;
    return formatRecord(raw, record.logLevel, record.logLevel === 'Error' || record.logLevel === 'Critical' ? 'stderr' : 'stdout');
}

function formatConsoleRecord(record: LogRecord, raw: string, category: string): AppHostParentOutput {
    const outputCategory = category === 'stderr' || record.logLevel === 'Error' || record.logLevel === 'Critical'
        ? 'stderr'
        : 'stdout';
    return formatRecord(raw.replace(/(?:\r\n|\r|\n)$/, ''), record.logLevel, outputCategory);
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

function getShortLoggerLevel(logLevel: AppHostLogLevel): string {
    switch (logLevel) {
        case 'Trace': return 'trce';
        case 'Debug': return 'dbug';
        case 'Information': return 'info';
        case 'Warning': return 'warn';
        case 'Error': return 'fail';
        case 'Critical': return 'crit';
    }
}

function getConsoleLogSeverity(line: string): 'low' | 'normal' | 'severe' | undefined {
    const level = /^(trce|dbug|info|warn|fail|crit):\s/.exec(line)?.[1];
    if (!level) {
        return undefined;
    }

    return level === 'trce' || level === 'dbug'
        ? 'low'
        : level === 'fail' || level === 'crit'
            ? 'severe'
            : 'normal';
}

function isIndentedContinuation(line: string): boolean {
    return /^\s+\S/.test(line);
}

function isSevereRuntimeOutputLine(line: string): boolean {
    return /(?:^|\s)(?:[A-Za-z_][\w`]*\.)+(?:[A-Za-z_][\w`]*Exception|Exception):/.test(line)
        || /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*Error|Error)(?:\s+\[[^\]]+\])?:/.test(line)
        || /^(?:fatal|critical|panic|aborted|segmentation\s+fault|unhandled\s+exception)\b/i.test(line);
}

import { applyTextStyle } from '../utils/strings';

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

interface PendingConsoleHeader {
    output: string;
    category: string;
}

export class AppHostLogOutputCoordinator {
    // Correlation is one-for-one, so repeated identical ILogger calls remain distinct.
    // The queue only needs to bridge provider/RPC interleaving and is owned by one
    // Aspire debug session; older records are never used for broad message suppression.
    private static readonly _maxCorrelatedRecords = 1024;
    private readonly _correlatedRecords: CorrelatedRecord[] = [];
    private readonly _fallbackFilter = new AppHostParentOutputFilter();
    private _highestBackchannelSequence = 0;
    private _pendingConsoleHeader: PendingConsoleHeader | undefined;

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

    handleDebugAdapterOutput(output: string, category: string | undefined): AppHostParentOutput[] {
        const normalizedCategory = category ?? 'console';
        const outputs: AppHostParentOutput[] = [];

        if (this._pendingConsoleHeader) {
            const pending = this._pendingConsoleHeader;
            this._pendingConsoleHeader = undefined;

            if (pending.category === normalizedCategory && isConsoleLoggerContinuation(output)) {
                const record = parseConsoleLoggerRecord(`${pending.output}${output}`);
                if (record) {
                    const correlated = this.correlate(record, 'consoleLogger');
                    return correlated ? [correlated] : [];
                }
            }

            const pendingOutput = this._fallbackFilter.filter(pending.output, pending.category);
            if (pendingOutput) {
                outputs.push(pendingOutput);
            }
        }

        const consoleRecord = parseConsoleLoggerRecord(output);
        if (consoleRecord) {
            const correlated = this.correlate(consoleRecord, 'consoleLogger');
            if (correlated) {
                outputs.push(correlated);
            }
            return outputs;
        }

        if (isConsoleLoggerHeader(output)) {
            this._pendingConsoleHeader = { output, category: normalizedCategory };
            return outputs;
        }

        // System.Diagnostics.Debug output is delivered as DAP `console` output,
        // while Console.WriteLine uses stdout/stderr. Restrict the DebugLogger
        // grammar to that provenance so user stdout shaped like
        // "Status: Error: connection refused" is never reclassified.
        const debugRecord = normalizedCategory === 'console' ? parseDebugLoggerRecord(output) : undefined;
        if (debugRecord) {
            const correlated = this.correlate(debugRecord, 'debugLogger');
            if (correlated) {
                outputs.push(correlated);
            }
            return outputs;
        }

        const filtered = this._fallbackFilter.filter(output, normalizedCategory);
        if (filtered) {
            outputs.push(filtered);
        }

        return outputs;
    }

    reset(): void {
        this._correlatedRecords.length = 0;
        this._highestBackchannelSequence = 0;
        this._pendingConsoleHeader = undefined;
        this._fallbackFilter.reset();
    }

    private correlate(record: AppHostLoggerRecord, source: AppHostLogSource): AppHostParentOutput | undefined {
        const existing = this._correlatedRecords.find(candidate =>
            !candidate.sources.has(source) && areEquivalentRecords(candidate.record, record));

        if (existing) {
            existing.sources.add(source);
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
        message,
        eventId: Number(match[3]),
        exception
    };
}

function isConsoleLoggerHeader(output: string): boolean {
    return /^(trce|dbug|info|warn|fail|crit): .+\[-?\d+\](?:\r\n|\r|\n)$/.test(output);
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
        message,
        exception
    };
}

function splitMessageAndException(value: string): { message: string; exception?: string } {
    const lines = normalizeLineEndings(value).split('\n');
    const exceptionIndex = lines.findIndex(line =>
        /^(?:[A-Za-z_][\w`]*(?:\.[A-Za-z_][\w`]*)*(?:Exception|Error):|Unhandled exception\.)/.test(line));

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

function areEquivalentRecords(left: AppHostLoggerRecord, right: AppHostLoggerRecord): boolean {
    return left.categoryName === right.categoryName
        && left.logLevel === right.logLevel
        && left.message === right.message
        && left.exception === right.exception
        && (left.eventId === undefined || right.eventId === undefined || left.eventId === right.eventId);
}

function formatLoggerRecord(record: AppHostLoggerRecord): AppHostParentOutput {
    const body = `${record.categoryName}: ${record.logLevel}: ${record.message}${record.exception ? `\n${record.exception}` : ''}`;
    const category = record.logLevel === 'Error' || record.logLevel === 'Critical' ? 'stderr' : 'stdout';
    const style = record.logLevel === 'Trace' || record.logLevel === 'Debug'
        ? '\x1b[2m'
        : record.logLevel === 'Warning'
            ? '\x1b[33m'
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
    return removeSingleTrailingNewline(normalizeLineEndings(value));
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

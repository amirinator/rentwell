/**
 * Payment import CSV parsing and validation.
 *
 * The expected header is exactly:
 *
 *     external_id,posted_date,amount,currency,reference,description
 *
 * Parsing and validation are deliberately separate from anything that writes to
 * the database. An accountant gets the full list of problems in one pass, fixes
 * the file, and re-uploads; nothing is committed until every error is cleared
 * and the confirmation is bound to the validated file's hash.
 *
 * The parser is hand-written rather than pulled from a library because the
 * failure modes that matter here are specific: a quoted field containing a
 * newline must not split a row, a stray BOM must not corrupt the first column
 * name, and a truncated quote must be reported as a file-level error rather
 * than silently swallowing the rest of the file.
 */

import {
  InvalidDateError,
  InvalidMoneyError,
  normalizeCurrency,
  parseAmountToCents,
  parseImportDate,
  sanitizeUntrustedText,
  type LocalDate,
} from '@rentwell/domain';

export const IMPORT_COLUMNS = [
  'external_id',
  'posted_date',
  'amount',
  'currency',
  'reference',
  'description',
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** Columns a row must fill in. `reference` and `description` may be blank. */
const REQUIRED_COLUMNS: readonly ImportColumn[] = [
  'external_id',
  'posted_date',
  'amount',
  'currency',
];

export interface ParsedImportRow {
  /** 1-based index among data rows, excluding the header. */
  readonly rowNumber: number;
  readonly externalId: string;
  readonly postedDate: LocalDate;
  readonly amountCents: number;
  readonly currency: string;
  readonly reference: string | null;
  readonly description: string | null;
  /** The original cells, retained so the import center can show the source. */
  readonly raw: Readonly<Record<string, string>>;
}

export type ImportErrorCode =
  | 'EMPTY_FILE'
  | 'MISSING_HEADER'
  | 'UNKNOWN_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'UNTERMINATED_QUOTE'
  | 'ROW_LIMIT_EXCEEDED'
  | 'WRONG_FIELD_COUNT'
  | 'MISSING_VALUE'
  | 'INVALID_DATE'
  | 'INVALID_AMOUNT'
  | 'ZERO_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'DUPLICATE_EXTERNAL_ID_IN_FILE'
  | 'FIELD_TOO_LONG';

export interface ImportError {
  /** Null for file-level problems such as a bad header. */
  readonly rowNumber: number | null;
  readonly column: string | null;
  readonly code: ImportErrorCode;
  readonly message: string;
  /** The offending value, truncated and stripped of control characters. */
  readonly value: string | null;
}

export interface ParseResult {
  readonly rows: readonly ParsedImportRow[];
  readonly errors: readonly ImportError[];
  readonly totalDataRows: number;
  readonly valid: boolean;
}

export interface ParseOptions {
  /** Currency the destination bank account is denominated in. */
  readonly expectedCurrency: string;
  readonly maxRows?: number;
  readonly maxFieldLength?: number;
}

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_FIELD_LENGTH = 512;

// --------------------------------------------------------------------------
// Tokenizer
// --------------------------------------------------------------------------

/**
 * Splits CSV text into rows of fields, honouring RFC 4180 quoting.
 *
 * Returns `null` on an unterminated quote, because at that point the row
 * boundaries for the rest of the file are unknowable and guessing would report
 * a cascade of misleading per-row errors instead of the one real problem.
 */
export function tokenizeCsv(text: string): string[][] | null {
  // Strip a UTF-8 BOM so the first header name is not "external_id".
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let sawAnyContent = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      fieldWasQuoted = true;
      sawAnyContent = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      fieldWasQuoted = false;
      sawAnyContent = true;
      continue;
    }

    if (char === '\r') {
      // Normalise CRLF and lone CR to a single row break.
      if (source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldWasQuoted = false;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldWasQuoted = false;
      continue;
    }

    field += char;
    sawAnyContent = true;
  }

  if (inQuotes) return null;

  // Flush the final row unless the file simply ended with a newline.
  if (field.length > 0 || row.length > 0 || fieldWasQuoted) {
    row.push(field);
    rows.push(row);
  }

  if (!sawAnyContent && rows.length === 0) return [];
  return rows;
}

// --------------------------------------------------------------------------
// Parsing and validation
// --------------------------------------------------------------------------

export function parseImportCsv(text: string, options: ParseOptions): ParseResult {
  const errors: ImportError[] = [];
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  const expectedCurrency = normalizeCurrency(options.expectedCurrency);

  const tokenized = tokenizeCsv(text);
  if (tokenized === null) {
    return fail(errors, {
      rowNumber: null,
      column: null,
      code: 'UNTERMINATED_QUOTE',
      message: 'The file ends inside a quoted field. Check for an unbalanced double quote.',
      value: null,
    });
  }

  const nonEmpty = tokenized.filter((row) => !(row.length === 1 && row[0]!.trim() === ''));
  if (nonEmpty.length === 0) {
    return fail(errors, {
      rowNumber: null,
      column: null,
      code: 'EMPTY_FILE',
      message: 'The file contains no rows.',
      value: null,
    });
  }

  const headerRow = nonEmpty[0]!.map((cell) => cell.trim().toLowerCase());
  const headerErrors = validateHeader(headerRow);
  if (headerErrors.length > 0) {
    return { rows: [], errors: headerErrors, totalDataRows: 0, valid: false };
  }

  const dataRows = nonEmpty.slice(1);
  if (dataRows.length > maxRows) {
    return fail(errors, {
      rowNumber: null,
      column: null,
      code: 'ROW_LIMIT_EXCEEDED',
      message: `The file has ${dataRows.length} rows; the limit is ${maxRows}. Split it into smaller files.`,
      value: null,
    });
  }

  const columnIndex = new Map<ImportColumn, number>();
  headerRow.forEach((name, index) => columnIndex.set(name as ImportColumn, index));

  const rows: ParsedImportRow[] = [];
  const seenExternalIds = new Map<string, number>();

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 1;

    if (cells.length !== headerRow.length) {
      errors.push({
        rowNumber,
        column: null,
        code: 'WRONG_FIELD_COUNT',
        message: `Expected ${headerRow.length} fields, found ${cells.length}.`,
        value: null,
      });
      return;
    }

    const raw: Record<string, string> = {};
    for (const column of IMPORT_COLUMNS) {
      raw[column] = (cells[columnIndex.get(column)!] ?? '').trim();
    }

    let rowHasError = false;
    const addError = (column: ImportColumn, code: ImportErrorCode, message: string): void => {
      rowHasError = true;
      errors.push({
        rowNumber,
        column,
        code,
        message,
        value: sanitizeUntrustedText(raw[column], 120) || null,
      });
    };

    for (const column of REQUIRED_COLUMNS) {
      if (raw[column]!.length === 0) {
        addError(column, 'MISSING_VALUE', `${column} is required.`);
      }
    }

    for (const column of IMPORT_COLUMNS) {
      if (raw[column]!.length > maxFieldLength) {
        addError(
          column,
          'FIELD_TOO_LONG',
          `${column} is longer than the ${maxFieldLength} character limit.`,
        );
      }
    }

    if (rowHasError) return;

    let postedDate: LocalDate;
    try {
      postedDate = parseImportDate(raw.posted_date!);
    } catch (error) {
      addError(
        'posted_date',
        'INVALID_DATE',
        error instanceof InvalidDateError ? error.message : 'Unreadable date.',
      );
      return;
    }

    let currency: string;
    try {
      currency = normalizeCurrency(raw.currency!);
    } catch {
      addError('currency', 'INVALID_CURRENCY', 'Currency must be a 3-letter ISO code.');
      return;
    }

    if (currency !== expectedCurrency) {
      addError(
        'currency',
        'CURRENCY_NOT_SUPPORTED',
        `This bank account is denominated in ${expectedCurrency}. Cross-currency import is rejected.`,
      );
      return;
    }

    let amountCents: number;
    try {
      amountCents = parseAmountToCents(raw.amount!, currency);
    } catch (error) {
      addError(
        'amount',
        'INVALID_AMOUNT',
        error instanceof InvalidMoneyError ? error.message : 'Unreadable amount.',
      );
      return;
    }

    if (amountCents === 0) {
      addError('amount', 'ZERO_AMOUNT', 'A zero-value payment cannot be reconciled.');
      return;
    }

    const externalId = raw.external_id!;
    const firstSeenAt = seenExternalIds.get(externalId);
    if (firstSeenAt !== undefined) {
      // Two rows claiming the same external id inside one file is always a
      // mistake: the record-level dedupe would silently drop the second.
      addError(
        'external_id',
        'DUPLICATE_EXTERNAL_ID_IN_FILE',
        `external_id also appears on row ${firstSeenAt}.`,
      );
      return;
    }
    seenExternalIds.set(externalId, rowNumber);

    rows.push({
      rowNumber,
      externalId,
      postedDate,
      amountCents,
      currency,
      reference: raw.reference!.length > 0 ? raw.reference! : null,
      description: raw.description!.length > 0 ? raw.description! : null,
      raw: Object.freeze({ ...raw }),
    });
  });

  return {
    rows,
    errors,
    totalDataRows: dataRows.length,
    valid: errors.length === 0 && rows.length > 0,
  };
}

function validateHeader(headerRow: readonly string[]): ImportError[] {
  const errors: ImportError[] = [];
  const seen = new Set<string>();

  for (const name of headerRow) {
    if (seen.has(name)) {
      errors.push({
        rowNumber: null,
        column: name,
        code: 'DUPLICATE_COLUMN',
        message: `Column "${name}" appears more than once.`,
        value: null,
      });
    }
    seen.add(name);
    if (!(IMPORT_COLUMNS as readonly string[]).includes(name)) {
      errors.push({
        rowNumber: null,
        column: name,
        code: 'UNKNOWN_COLUMN',
        message: `Unexpected column "${sanitizeUntrustedText(name, 60)}".`,
        value: null,
      });
    }
  }

  for (const expected of IMPORT_COLUMNS) {
    if (!seen.has(expected)) {
      errors.push({
        rowNumber: null,
        column: expected,
        code: 'MISSING_HEADER',
        message: `Required column "${expected}" is missing. Expected header: ${IMPORT_COLUMNS.join(',')}`,
        value: null,
      });
    }
  }

  return errors;
}

function fail(errors: ImportError[], error: ImportError): ParseResult {
  return { rows: [], errors: [...errors, error], totalDataRows: 0, valid: false };
}

// --------------------------------------------------------------------------
// Export safety
// --------------------------------------------------------------------------

/**
 * Escapes a value for CSV export so a spreadsheet does not execute it.
 *
 * A cell beginning with `=`, `+`, `-`, `@`, tab or carriage return is treated
 * as a formula by Excel, Google Sheets and LibreOffice. Prefixing with a single
 * quote neutralises it while remaining readable. Applied to every exported
 * cell, including ones that originated inside Rentwell, because a tenant name
 * or payment memo can carry the payload.
 *
 * A plain signed decimal is exempt, so `-1234.56` exports as a number a
 * spreadsheet can sum rather than as the text `'-1234.56`. `-1+1` is not a
 * plain decimal and is still neutralised.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const needsGuard = /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text);
  const neutralised = needsGuard ? `'${text}` : text;

  if (/[",\n\r]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

export function toCsvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(escapeCsvCell).join(',');
}

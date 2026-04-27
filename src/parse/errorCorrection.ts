const NUMERIC_FIELDS = new Set([
  'birthDate',
  'birthDateCheckDigit',
  'expirationDate',
  'expirationDateCheckDigit',
  'documentNumberCheckDigit',
  'compositeCheckDigit',
  'personalNumberCheckDigit',
  'issueDate',
]);

const ALPHA_FIELDS = new Set([
  'documentCode',
  'issuingState',
  'nationality',
  'lastName',
  'firstName',
  'sex',
  'languageCode',
]);

const ALPHA_TO_DIGIT: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  S: '5',
  B: '8',
  Z: '2',
};

const DIGIT_TO_ALPHA: Readonly<Record<string, string>> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B',
  '2': 'Z',
};

export interface Substitution {
  line: number;
  col: number;
  original: string;
  corrected: string;
  field: string;
}

interface FieldDetail {
  field: string | null;
  ranges: ReadonlyArray<{ line: number; start: number; end: number }>;
}

/**
 * Apply field-type-aware OCR error corrections to raw MRZ lines.
 *
 * - Numeric fields (dates, check digits): swap alpha confusables → digits (O→0, I→1, …)
 * - Alpha fields (names, country codes, sex): swap digit confusables → alpha (0→O, 1→I, …)
 * - Mixed/alphanumeric fields (document number, optional): left untouched
 *
 * Uses field range positions from the mrz parse result to avoid blind global substitution.
 */
export function applyErrorCorrection(
  lines: string[],
  details: readonly FieldDetail[],
): { correctedLines: string[]; substitutions: Substitution[] } {
  const mutableLines = lines.map(l => Array.from(l));
  const substitutions: Substitution[] = [];

  for (const detail of details) {
    const fieldName = detail.field;
    if (fieldName === null) continue;

    const isNumeric = NUMERIC_FIELDS.has(fieldName);
    const isAlpha = ALPHA_FIELDS.has(fieldName);
    if (!isNumeric && !isAlpha) continue;

    const map = isNumeric ? ALPHA_TO_DIGIT : DIGIT_TO_ALPHA;

    // ranges[0] is always the main field position (additional entries are related ranges
    // used for composite check digit validation — we only correct the field itself)
    const mainRange = detail.ranges[0];
    if (mainRange === undefined) continue;

    const lineArr = mutableLines[mainRange.line];
    if (lineArr === undefined) continue;

    for (let col = mainRange.start; col < mainRange.end; col++) {
      const char = lineArr[col];
      if (char === undefined) continue;
      const corrected = map[char];
      if (corrected !== undefined) {
        substitutions.push({ line: mainRange.line, col, original: char, corrected, field: fieldName });
        lineArr[col] = corrected;
      }
    }
  }

  return {
    correctedLines: mutableLines.map(arr => arr.join('')),
    substitutions,
  };
}

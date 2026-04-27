const WEIGHTS = [7, 3, 1] as const;

function charValue(ch: string): number {
  if (ch === '<') return 0;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;       // '0'–'9' → 0–9
  if (code >= 65 && code <= 90) return code - 55;       // 'A'–'Z' → 10–35
  return 0;
}

/** Compute the ICAO 9303 check digit for a field string. Returns the single digit char '0'–'9'. */
export function computeCheckDigit(field: string): string {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += charValue(field[i] ?? '') * (WEIGHTS[i % 3] ?? 7);
  }
  return String(sum % 10);
}

/** Return true if the ICAO check digit of `field` matches `digit`. */
export function validateCheckDigit(field: string, digit: string): boolean {
  return computeCheckDigit(field) === digit;
}

export interface CheckDigitReport {
  field: string;
  computedDigit: string;
  expectedDigit: string;
  valid: boolean;
}

/**
 * Independently validate all ICAO 9303 check digits in a set of MRZ lines.
 * Returns one report per check digit field; an empty array for unknown formats.
 */
export function validateMRZCheckDigits(
  lines: readonly string[],
  format: string,
): CheckDigitReport[] {
  const reports: CheckDigitReport[] = [];
  const l0 = lines[0] ?? '';
  const l1 = lines[1] ?? '';

  function check(fieldName: string, fieldStr: string, digit: string) {
    const computedDigit = computeCheckDigit(fieldStr);
    reports.push({ field: fieldName, computedDigit, expectedDigit: digit, valid: computedDigit === digit });
  }

  if (format === 'TD3' || format === 'MRV-A') {
    check('documentNumber',   l1.slice(0, 9),    l1[9] ?? '');
    check('birthDate',        l1.slice(13, 19),  l1[19] ?? '');
    check('expirationDate',   l1.slice(21, 27),  l1[27] ?? '');
    const composite = l1.slice(0, 10) + l1.slice(13, 20) + l1.slice(21, 43);
    check('compositeCheckDigit', composite, l1[43] ?? '');
  } else if (format === 'TD1') {
    check('documentNumber',   l0.slice(5, 14),   l0[14] ?? '');
    check('birthDate',        l1.slice(0, 6),    l1[6] ?? '');
    check('expirationDate',   l1.slice(8, 14),   l1[14] ?? '');
    const composite = l0.slice(5, 30) + l1.slice(0, 7) + l1.slice(8, 15) + l1.slice(18, 29);
    check('compositeCheckDigit', composite, l1[29] ?? '');
  } else if (format === 'TD2' || format === 'MRV-B') {
    check('documentNumber',   l1.slice(0, 9),    l1[9] ?? '');
    check('birthDate',        l1.slice(13, 19),  l1[19] ?? '');
    check('expirationDate',   l1.slice(21, 27),  l1[27] ?? '');
    const composite = l1.slice(0, 10) + l1.slice(13, 20) + l1.slice(21, 35);
    check('compositeCheckDigit', composite, l1[35] ?? '');
  }

  return reports;
}

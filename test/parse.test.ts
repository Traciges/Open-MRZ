import { describe, it, expect } from 'vitest';
import { computeCheckDigit, validateCheckDigit, validateMRZCheckDigits } from '../src/parse/validator.js';
import { applyErrorCorrection } from '../src/parse/errorCorrection.js';
import { MRZParser } from '../src/parse/MRZParser.js';

// ---------------------------------------------------------------------------
// ICAO 9303 reference MRZ strings (check digits manually verified)
// ---------------------------------------------------------------------------

// TD3 — passport, 2×44 (ICAO 9303 specimen with real country code GBR, check digits verified)
const TD3_VALID = [
  'P<GBRERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36GBR7408122F1204159ZE184226B<<<<<10',
];

// TD1 — ID card, 3×30 (same specimen, GBR)
const TD1_VALID = [
  'I<GBRD231458907<<<<<<<<<<<<<<<',
  '7408122F1204159GBR<<<<<<<<<<<6',
  'ERIKSSON<<ANNA<MARIA<<<<<<<<<<',
];

// TD2 — 2×36 (same specimen, GBR, check digits verified)
const TD2_VALID = [
  'I<GBRERIKSSON<<ANNA<MARIA<<<<<<<<<<<',
  'D231458907GBR7408122F1204159<<<<<<<6',
];

// Fake uniform confidences (all characters 0.95)
function fakeConf(lines: string[]): number[][] {
  return lines.map(l => Array.from({ length: l.length }, () => 0.95));
}

// ---------------------------------------------------------------------------
// validator.ts — computeCheckDigit
// ---------------------------------------------------------------------------

describe('computeCheckDigit', () => {
  it('document number L898902C3 → check digit 6', () => {
    expect(computeCheckDigit('L898902C3')).toBe('6');
  });

  it('birth date 740812 → check digit 2', () => {
    expect(computeCheckDigit('740812')).toBe('2');
  });

  it('expiry date 120415 → check digit 9', () => {
    expect(computeCheckDigit('120415')).toBe('9');
  });

  it('TD1 document number D23145890 → check digit 7', () => {
    expect(computeCheckDigit('D23145890')).toBe('7');
  });

  it('all fillers (<<<<) → check digit 0', () => {
    expect(computeCheckDigit('<<<<')).toBe('0');
  });

  it('single zero → check digit 0', () => {
    expect(computeCheckDigit('0')).toBe('0');
  });

  it('single A → 10*7 mod 10 = 0', () => {
    expect(computeCheckDigit('A')).toBe('0');
  });

  it('single Z → 35*7=245 mod 10 = 5', () => {
    expect(computeCheckDigit('Z')).toBe('5');
  });
});

describe('validateCheckDigit', () => {
  it('returns true for correct digit', () => {
    expect(validateCheckDigit('L898902C3', '6')).toBe(true);
  });

  it('returns false for wrong digit', () => {
    expect(validateCheckDigit('L898902C3', '7')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validator.ts — validateMRZCheckDigits
// ---------------------------------------------------------------------------

describe('validateMRZCheckDigits', () => {
  it('TD3: all four check digits valid', () => {
    const reports = validateMRZCheckDigits(TD3_VALID, 'TD3');
    expect(reports).toHaveLength(4);
    for (const r of reports) {
      expect(r.valid).toBe(true);
    }
  });

  it('TD1: all four check digits valid', () => {
    const reports = validateMRZCheckDigits(TD1_VALID, 'TD1');
    expect(reports).toHaveLength(4);
    for (const r of reports) {
      expect(r.valid).toBe(true);
    }
  });

  it('TD2: all four check digits valid', () => {
    const reports = validateMRZCheckDigits(TD2_VALID, 'TD2');
    expect(reports).toHaveLength(4);
    for (const r of reports) {
      expect(r.valid).toBe(true);
    }
  });

  it('corrupted check digit → that field reports invalid', () => {
    const corrupted = [TD3_VALID[0]!, TD3_VALID[1]!.slice(0, 9) + '9' + TD3_VALID[1]!.slice(10)];
    const reports = validateMRZCheckDigits(corrupted, 'TD3');
    const docNum = reports.find(r => r.field === 'documentNumber');
    expect(docNum?.valid).toBe(false);
  });

  it('unknown format → empty report array', () => {
    const reports = validateMRZCheckDigits(TD3_VALID, 'UNKNOWN');
    expect(reports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// errorCorrection.ts — applyErrorCorrection
// ---------------------------------------------------------------------------

describe('applyErrorCorrection', () => {
  it('replaces O with 0 in a NUMERIC field range', () => {
    const lines = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO74O8122F1204159ZE184226B<<<<<10'];
    // Simulate details for birthDate at line 1, start 13, end 19
    const fakeDetails = [{ field: 'birthDate', ranges: [{ line: 1, start: 13, end: 19 }] }];
    const { correctedLines, substitutions } = applyErrorCorrection(lines, fakeDetails);
    // Position 15 is 'O' (within 13..18)
    expect(correctedLines[1]![15]).toBe('0');
    expect(substitutions).toHaveLength(1);
    expect(substitutions[0]).toMatchObject({ line: 1, col: 15, original: 'O', corrected: '0', field: 'birthDate' });
  });

  it('replaces 0 with O in an ALPHA field range (issuingState)', () => {
    const lines = ['P<UT0ERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
    // issuingState at line 0, start 2, end 5
    const fakeDetails = [{ field: 'issuingState', ranges: [{ line: 0, start: 2, end: 5 }] }];
    const { correctedLines, substitutions } = applyErrorCorrection(lines, fakeDetails);
    // Position 4 is '0' → should become 'O'
    expect(correctedLines[0]![4]).toBe('O');
    expect(substitutions[0]).toMatchObject({ original: '0', corrected: 'O', field: 'issuingState' });
  });

  it('makes no substitutions when no confusables are present', () => {
    const { substitutions } = applyErrorCorrection(
      TD3_VALID,
      [{ field: 'birthDate', ranges: [{ line: 1, start: 13, end: 19 }] }],
    );
    expect(substitutions).toHaveLength(0);
  });

  it('skips null field names', () => {
    const { substitutions } = applyErrorCorrection(
      TD3_VALID,
      [{ field: null, ranges: [{ line: 1, start: 0, end: 44 }] }],
    );
    expect(substitutions).toHaveLength(0);
  });

  it('skips alphanumeric fields (documentNumber)', () => {
    const lines = ['...', 'O898902036UTO7408122F1204159ZE184226B<<<<<10'];
    const fakeDetails = [{ field: 'documentNumber', ranges: [{ line: 1, start: 0, end: 9 }] }];
    const { substitutions } = applyErrorCorrection(lines, fakeDetails);
    expect(substitutions).toHaveLength(0);
  });

  it('applies all five ALPHA→DIGIT substitutions in a numeric field', () => {
    const lines = ['', 'OISBZ<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<'];
    // birthDate at line 1, start 0, end 5 (covers O,I,S,B,Z)
    const fakeDetails = [{ field: 'birthDate', ranges: [{ line: 1, start: 0, end: 5 }] }];
    const { correctedLines } = applyErrorCorrection(lines, fakeDetails);
    expect(correctedLines[1]!.slice(0, 5)).toBe('01582');
  });

  it('applies all five DIGIT→ALPHA substitutions in an alpha field', () => {
    const lines = ['01582<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', ''];
    // firstName at line 0, start 0, end 5 (covers 0,1,5,8,2)
    const fakeDetails = [{ field: 'firstName', ranges: [{ line: 0, start: 0, end: 5 }] }];
    const { correctedLines } = applyErrorCorrection(lines, fakeDetails);
    expect(correctedLines[0]!.slice(0, 5)).toBe('OISBZ');
  });

  it('is idempotent — second run finds no more corrections', () => {
    const lines = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO74O8122F1204159ZE184226B<<<<<10'];
    const fakeDetails = [{ field: 'birthDate', ranges: [{ line: 1, start: 13, end: 19 }] }];
    const { correctedLines } = applyErrorCorrection(lines, fakeDetails);
    const { substitutions: second } = applyErrorCorrection(correctedLines, fakeDetails);
    expect(second).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MRZParser — valid parses
// ---------------------------------------------------------------------------

describe('MRZParser.parse — TD3 valid', () => {
  const parser = new MRZParser();
  const conf = fakeConf(TD3_VALID);
  const result = parser.parse(TD3_VALID, conf);

  it('valid === true', () => expect(result.valid).toBe(true));
  it('format === TD3', () => expect(result.format).toBe('TD3'));
  it('surname = ERIKSSON', () => expect(result.fields.surname).toBe('ERIKSSON'));
  it('givenNames includes ANNA MARIA', () => expect(result.fields.givenNames).toContain('ANNA'));
  it('issuingState = GBR', () => expect(result.fields.issuingState).toBe('GBR'));
  it('nationality = GBR', () => expect(result.fields.nationality).toBe('GBR'));
  it('documentNumber = L898902C3', () => expect(result.fields.documentNumber).toBe('L898902C3'));
  it('dateOfBirth = 1974-08-12', () => expect(result.fields.dateOfBirth).toBe('1974-08-12'));
  it('sex = female', () => expect(result.fields.sex).toBe('female'));
  it('expiryDate = 2012-04-15', () => expect(result.fields.expiryDate).toBe('2012-04-15'));
  it('documentType = P', () => expect(result.fields.documentType).toBe('P'));
  it('raw lines preserved', () => expect(result.raw).toEqual(TD3_VALID));
  it('confidence ≈ 0.95', () => expect(result.confidence).toBeCloseTo(0.95, 2));
  it('processingTimeMs ≥ 0', () => expect(result.processingTimeMs).toBeGreaterThanOrEqual(0));
  it('details is non-empty array', () => expect(result.details.length).toBeGreaterThan(0));
  it('each detail has required shape', () => {
    for (const d of result.details) {
      expect(typeof d.field).toBe('string');
      expect(typeof d.valid).toBe('boolean');
      expect(Array.isArray(d.ranges)).toBe(true);
    }
  });
});

describe('MRZParser.parse — TD1 valid', () => {
  const parser = new MRZParser();
  const result = parser.parse(TD1_VALID, fakeConf(TD1_VALID));

  it('valid === true', () => expect(result.valid).toBe(true));
  it('format === TD1', () => expect(result.format).toBe('TD1'));
  it('documentNumber = D23145890', () => expect(result.fields.documentNumber).toBe('D23145890'));
  it('issuingState = GBR', () => expect(result.fields.issuingState).toBe('GBR'));
  it('dateOfBirth = 1974-08-12', () => expect(result.fields.dateOfBirth).toBe('1974-08-12'));
  it('sex = female', () => expect(result.fields.sex).toBe('female'));
  it('expiryDate = 2012-04-15', () => expect(result.fields.expiryDate).toBe('2012-04-15'));
});

describe('MRZParser.parse — TD2 valid', () => {
  const parser = new MRZParser();
  const result = parser.parse(TD2_VALID, fakeConf(TD2_VALID));

  it('valid === true', () => expect(result.valid).toBe(true));
  it('format === TD2', () => expect(result.format).toBe('TD2'));
  it('documentNumber = D23145890', () => expect(result.fields.documentNumber).toBe('D23145890'));
  it('dateOfBirth = 1974-08-12', () => expect(result.fields.dateOfBirth).toBe('1974-08-12'));
});

// ---------------------------------------------------------------------------
// MRZParser — error correction
// ---------------------------------------------------------------------------

describe('MRZParser.parse — error correction restores valid result', () => {
  const parser = new MRZParser();

  it('O→0 in birth date field: corrects and produces valid result', () => {
    // Replace '0' at position 15 of line 2 (inside "740812" birth date) with 'O'
    const corrupted = [
      TD3_VALID[0]!,
      TD3_VALID[1]!.slice(0, 15) + 'O' + TD3_VALID[1]!.slice(16),
    ];
    const result = parser.parse(corrupted, fakeConf(corrupted));
    expect(result.valid).toBe(true);
    expect(result.fields.dateOfBirth).toBe('1974-08-12');
    // raw lines are the original (pre-correction) input
    expect(result.raw[1]![15]).toBe('O');
  });

  it('I→1 in expiry date: corrects and produces valid result', () => {
    // Replace '1' at position 21 (start of "120415") with 'I'
    const corrupted = [
      TD3_VALID[0]!,
      TD3_VALID[1]!.slice(0, 21) + 'I' + TD3_VALID[1]!.slice(22),
    ];
    const result = parser.parse(corrupted, fakeConf(corrupted));
    expect(result.valid).toBe(true);
    expect(result.fields.expiryDate).toBe('2012-04-15');
  });

  it('multiple confusables in different numeric fields: all corrected', () => {
    // Corrupt birth date AND expiry date
    let line2 = TD3_VALID[1]!;
    line2 = line2.slice(0, 15) + 'O' + line2.slice(16); // 0→O in birth date
    line2 = line2.slice(0, 21) + 'I' + line2.slice(22); // 1→I in expiry date
    const corrupted = [TD3_VALID[0]!, line2];
    const result = parser.parse(corrupted, fakeConf(corrupted));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MRZParser — non-correctable errors → valid === false
// ---------------------------------------------------------------------------

describe('MRZParser.parse — non-correctable errors', () => {
  const parser = new MRZParser();

  it('wrong composite check digit (digit, not a confusable) → valid = false', () => {
    // Flip '0' (last char, composite CD) to '1' — '1' is already a digit, error correction
    // applies ALPHA→DIGIT only, so '1' won't be touched
    const corrupted = [
      TD3_VALID[0]!,
      TD3_VALID[1]!.slice(0, 43) + '1',
    ];
    const result = parser.parse(corrupted, fakeConf(corrupted));
    expect(result.valid).toBe(false);
  });

  it('completely garbage lines → valid = false, no crash', () => {
    const garbage = [
      'NOTAVALIDMRZLINE1234567890ABCDEFGHIJKLMN',
      '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ<<<<',
    ];
    const result = parser.parse(garbage, fakeConf(garbage));
    expect(result.valid).toBe(false);
    expect(result.raw).toEqual(garbage);
  });

  it('wrong number of lines → valid = false, no crash', () => {
    const result = parser.parse(['ONLYONELINE<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<'], []);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MRZParser — confidence & timing
// ---------------------------------------------------------------------------

describe('MRZParser.parse — confidence', () => {
  const parser = new MRZParser();

  it('confidence = mean of all charConfidences', () => {
    const confs = [[0.8, 0.9], [0.7, 1.0]];
    // Use TD3 lines but custom confidences (won't match TD3 line length — that's OK here)
    const result = parser.parse(TD3_VALID, confs);
    const expected = (0.8 + 0.9 + 0.7 + 1.0) / 4;
    expect(result.confidence).toBeCloseTo(expected, 5);
  });

  it('empty charConfidences → confidence = 0', () => {
    const result = parser.parse(TD3_VALID, []);
    expect(result.confidence).toBe(0);
  });

  it('processingTimeMs is a non-negative number', () => {
    const result = parser.parse(TD3_VALID, fakeConf(TD3_VALID));
    expect(typeof result.processingTimeMs).toBe('number');
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

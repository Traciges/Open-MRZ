import { parse as mrzParse } from 'mrz';
import type { ParseResult as MrzLibResult } from 'mrz';
import type { MRZFormat, MRZResult, MRZFields } from '../types.js';
import { applyErrorCorrection } from './errorCorrection.js';

function formatDate(raw: string | null | undefined): string | null {
  if (!raw || raw.length < 6 || raw.includes('<')) return null;
  const yy = parseInt(raw.slice(0, 2), 10);
  if (isNaN(yy)) return null;
  const mm = raw.slice(2, 4);
  const dd = raw.slice(4, 6);
  // ICAO century heuristic: YY ≥ 30 → 19XX, YY < 30 → 20XX
  const yyyy = yy >= 30 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

function mapSex(value: string | null | undefined): 'male' | 'female' | 'neutral' | null {
  switch (value) {
    case 'male':         return 'male';
    case 'female':       return 'female';
    case 'nonspecified': return 'neutral';
    default:             return null;
  }
}

function mapFormat(libFormat: string, firstDocChar: string): MRZFormat {
  if (firstDocChar === 'V') {
    if (libFormat === 'TD3') return 'MRV-A';
    if (libFormat === 'TD2') return 'MRV-B';
  }
  if (libFormat === 'TD1') return 'TD1';
  if (libFormat === 'TD2') return 'TD2';
  return 'TD3';
}

function buildResult(
  libResult: MrzLibResult,
  correctedLines: string[],
  originalLines: string[],
  charConfidences: number[][],
  processingTimeMs: number,
): MRZResult {
  const { format: libFormat, valid, fields, details } = libResult;

  const firstDocChar = correctedLines[0]?.[0] ?? '';
  const secondDocChar = correctedLines[0]?.[1];
  const format = mapFormat(String(libFormat), firstDocChar);

  const mrzFields: MRZFields = {
    documentType:        firstDocChar || null,
    documentSubtype:     secondDocChar && secondDocChar !== '<' ? secondDocChar : null,
    issuingState:        fields.issuingState ?? null,
    surname:             fields.lastName ?? null,
    givenNames:          fields.firstName ?? null,
    documentNumber:      fields.documentNumber ?? null,
    nationality:         fields.nationality ?? null,
    dateOfBirth:         formatDate(fields.birthDate),
    sex:                 mapSex(fields.sex),
    expiryDate:          formatDate(fields.expirationDate),
    // TD3 uses personalNumber, TD2 uses optional, TD1 uses optional1/optional2
    optionalData:        fields.personalNumber ?? fields.optional ?? fields.optional1 ?? null,
    optionalData2:       fields.optional2 ?? null,
    compositeCheckDigit: details.find(d => d.field === 'compositeCheckDigit')?.value ?? null,
  };

  const allConfs = charConfidences.flat();
  const confidence =
    allConfs.length > 0 ? allConfs.reduce((s, c) => s + c, 0) / allConfs.length : 0;

  return {
    format,
    valid,
    fields: mrzFields,
    details: details.map(d => ({
      field:  d.label,
      value:  d.value,
      valid:  d.valid,
      ranges: d.ranges.map(r => ({ line: r.line, start: r.start, end: r.end })),
    })),
    raw: originalLines,
    confidence,
    processingTimeMs,
  };
}

const EMPTY_FIELDS: MRZFields = {
  documentType: null, documentSubtype: null, issuingState: null,
  surname: null, givenNames: null, documentNumber: null,
  nationality: null, dateOfBirth: null, sex: null, expiryDate: null,
  optionalData: null, optionalData2: null, compositeCheckDigit: null,
};

export class MRZParser {
  /**
   * Parse raw MRZ lines into a structured MRZResult.
   *
   * Attempts up to 3 rounds of ICAO OCR-error correction if the first parse
   * is invalid, then returns the best result achieved.
   */
  parse(lines: string[], charConfidences: number[][]): MRZResult {
    const t0 = performance.now();
    const originalLines = lines;

    let libResult: MrzLibResult;
    try {
      libResult = mrzParse(lines);
    } catch {
      return {
        format: 'TD3',
        valid: false,
        fields: { ...EMPTY_FIELDS },
        details: [],
        raw: originalLines,
        confidence: 0,
        processingTimeMs: performance.now() - t0,
      };
    }

    if (libResult.valid) {
      return buildResult(libResult, lines, originalLines, charConfidences, performance.now() - t0);
    }

    // Error correction loop — up to 3 rounds, stop when no new substitutions
    let correctedLines = lines;
    for (let round = 0; round < 3; round++) {
      const { correctedLines: next, substitutions } = applyErrorCorrection(
        correctedLines,
        libResult.details,
      );
      if (substitutions.length === 0) break;

      correctedLines = next;
      try {
        libResult = mrzParse(correctedLines);
      } catch {
        break;
      }
      if (libResult.valid) break;
    }

    return buildResult(libResult, correctedLines, originalLines, charConfidences, performance.now() - t0);
  }
}

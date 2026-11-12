// The CSV format choice, remembered per browser. Read and written inside try/catch: storage can be
// missing or blocked, and then the choice simply lasts until reload.
import type { CsvFormat } from './csv.ts';

const KEY = 'sim-csv-format';

/** The part of Storage this needs, so it can be tested without a browser. */
export interface FormatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The remembered format; standard when none is stored, the value is unknown or storage fails. */
export function loadCsvFormat(storage: FormatStorage | null): CsvFormat {
  try {
    return storage?.getItem(KEY) === 'excel-eu' ? 'excel-eu' : 'standard';
  } catch {
    return 'standard';
  }
}

export function saveCsvFormat(storage: FormatStorage | null, format: CsvFormat): void {
  try {
    storage?.setItem(KEY, format);
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}

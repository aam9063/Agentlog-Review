import type { DriftFinding, DriftScope } from "../model/types.ts";

/**
 * Declared shape of one entry type.
 *
 * `keys` is every key the format is known to use; a key outside it is drift.
 * `required` is the minimum an entry needs to be usable; a missing one is drift
 * too, because the entry cannot be interpreted.
 */
export interface KeyContract {
  readonly keys: readonly string[];
  readonly required: readonly string[];
}

/**
 * Compares an entry's actual keys against its contract.
 *
 * Drift is a finding, never a reason to drop the entry: the entry still becomes
 * an event and its line still sits in `raw`, so nothing is lost while the
 * schema moves.
 */
export function findDrift(
  lineNumber: number,
  scope: DriftScope,
  type: string,
  actual: readonly string[],
  contract: KeyContract,
): DriftFinding | null {
  const known = new Set(contract.keys);
  const present = new Set(actual);
  const unknownKeys = actual.filter((key) => !known.has(key));
  const missingKeys = contract.required.filter((key) => !present.has(key));
  if (unknownKeys.length === 0 && missingKeys.length === 0) {
    return null;
  }
  return { lineNumber, scope, type, unknownKeys, missingKeys };
}

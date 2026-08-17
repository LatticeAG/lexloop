/** MVP stub. Phase 12 enables token_sort / minilm. Spec D11. */

export const enabled = false;

export class SemanticDisabledError extends Error {
  readonly code = "LL1005" as const;

  constructor(message = "LL1005 semantic called while disabled") {
    super(message);
    this.name = "SemanticDisabledError";
  }
}

function disabled(): never {
  throw new SemanticDisabledError();
}

export function similarity(_a: string, _b: string): never {
  return disabled();
}

export function embed(_text: string): never {
  return disabled();
}

export function tokenSort(_a: string, _b: string): never {
  return disabled();
}

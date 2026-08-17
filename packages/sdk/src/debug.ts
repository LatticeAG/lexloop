/** packages/sdk/src/debug.ts */

export function sdkLog(code: string, err?: unknown): void {
  const extra =
    err === undefined ? "" : ` ${err instanceof Error ? err.message : String(err)}`;
  console.error(`[lexloop] ${code}${extra}`);
}

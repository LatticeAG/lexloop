export function exitWith(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

export function isConfigError(err: unknown): err is { code: "LL4001"; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "LL4001"
  );
}

export function formatUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

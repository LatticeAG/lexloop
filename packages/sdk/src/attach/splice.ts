/** packages/sdk/src/attach/splice.ts */

export function spliceMessages<T extends { role: string; content?: unknown }>(
  messages: T[],
  text: string,
  role: "system" | "user",
): T[] {
  const copy = messages.slice();
  copy.push({ role, content: text } as T);
  return copy;
}

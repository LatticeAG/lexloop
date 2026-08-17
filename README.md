# LexLoop

LexLoop watches agent runs, classifies stuck vs productive, and injects a targeted message.

OSS MIT: detector, rule classifier, soft-nudge templates, TypeScript SDK, CLI, golden corpus, JSONL log. Usable offline. Hosted aggregate loop summaries are invite-only. Summaries only, no transcripts.

SDK default is log-only. `lexloop watch` default is intervene.

## Node versions

CI Node matrix is 20.19 and 22. This host runs Node 24. `engines.node` is `>=20.19`. Do not use Node 23-only APIs.

## Packages

- `@latticeag/lexloop` SDK
- `@latticeag/lexloop-core`
- `@latticeag/lexloop-events`
- `@latticeag/lexloop-config`
- `@latticeag/lexloop-cli` bin `lexloop`

```
pnpm install
pnpm --filter @latticeag/lexloop-cli build
pnpm test
lexloop --help
```

## LangGraph (custom kit)

There is no `graph.attach()` in v0.1. Call `maybeInject` from a `before_model` hook:

```ts
import { LexLoop } from "@latticeag/lexloop";
const lex = new LexLoop();
async function before_model(state: { messages: Array<{ role: string; content?: string | null }> }) {
  const messages = await lex.maybeInject(state.messages);
  return { messages };
}
```

Observe tool results from a ToolNode wrapper with `lex.observe(...)`. A first-class `wrapLangGraph` is later.

## License

MIT. Copyright 2026 LatticeAG.

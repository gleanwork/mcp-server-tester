# Registered hosts return scenario traces

A registered host executes one scenario. It does not build datasets, repeat cases,
run judges, or return `pass`/`passed`/`caseResults`. Those remain owned by
`runEvalDataset` for every host.

```typescript
import { registerHost } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

registerHost({
  name: 'my-assistant',
  schema: z.object({ type: z.literal('my-assistant') }),
  evidence: 'observed',
  async run(input, config, context) {
    // input.scenario and input.servers are the unit of execution.
    // A driver may reject unsupported server sets itself.
    return { finalText: 'Answer from the assistant', events: [] };
  },
});
```

`HostRunResult` contains `finalText`, `events`, optional `usage`, and optional
`error`. Events record a `kind` (`tool_call`, `skill`, `command`, or `subagent`),
`source` (`mcp` or `host`), `name`, and optional MCP server label, arguments,
output, and ID. Preserve evidence; do not reconstruct authoritative tool calls
from final prose.

Declare `evidence: 'structured'` only for authoritative protocol or host-native
structured traces. `observed`, `none`, and an omitted declaration cannot satisfy
structured tool-call or argument assertions; ordinary text and judge assertions
still run. Raw events and evidence remain in the stored case response.

The framework adapts traces to the existing assertion validators once, at the
runner boundary. MCP server labels remain in events; multi-server tool assertions
use label-qualified names (or the manifest's canonical-to-native `toolMap`).

`createConfig` is an optional compatibility shim for existing SDK/CLI settings,
not a requirement for a new host. Low-level SDK/CLI/external-host APIs remain
available for existing independent tests. New manifest cases can use `mode: 'host'`
and a case-level tagged `host` override. Registered host context is exported as
`EvaluationHostRunContext` to avoid colliding with the older external-driver API.

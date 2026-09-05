---
'@ai-sdk/anthropic': patch
---

fix(anthropic): streamed `code_execution` tool calls no longer lose their input type discriminator when the full input arrives in the initial `server_tool_use` block without deltas.

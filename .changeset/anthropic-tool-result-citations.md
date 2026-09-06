---
'@ai-sdk/anthropic': patch
---

feat(anthropic): support for citations based on documents in tool results. `text/plain` and PDF file parts inside `content` tool result outputs accept the `citations`, `title` and `context` provider options, and their citations are resolved to `source` parts.

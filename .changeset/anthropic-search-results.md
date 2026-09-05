---
'@ai-sdk/anthropic': patch
---

feat(anthropic): support for search results in tool results. Custom tool result content parts with `providerOptions.anthropic.type: 'search-result'` are sent as `search_result` blocks, and `search_result_location` citations are emitted as url or document sources.

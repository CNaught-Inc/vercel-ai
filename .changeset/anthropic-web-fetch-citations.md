---
'@ai-sdk/anthropic': patch
---

fix(anthropic): resolve citations to web_fetch pages

Pages fetched by the provider-executed `web_fetch` tool in earlier assistant messages now count toward citation `document_index`, so later document citations no longer resolve to the wrong document or get dropped. Citations to a fetched page are now emitted as `url` sources carrying the page URL.

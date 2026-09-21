---
'@ai-sdk/anthropic': patch
---

feat(anthropic): support Workload Identity Federation via the `federation` provider setting and the `ANTHROPIC_FEDERATION_RULE_ID` / `ANTHROPIC_ORGANIZATION_ID` environment variables. The provider exchanges the workload's OIDC identity token for a short-lived access token, caches and refreshes it, and retries once with a fresh token on 401.

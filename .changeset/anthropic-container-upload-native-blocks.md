---
'@ai-sdk/anthropic': patch
---

fix(anthropic): `containerUpload: true` on a provider referenced file part also emits the native image or document block for media types Claude reads natively (images, PDF, `text/plain`), so the model can both see the file and open it in the container.

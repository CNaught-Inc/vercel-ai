import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { readFile } from 'node:fs/promises';
import { print } from '../../lib/print';
import { run } from '../../lib/run';

// Requires ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and
// ANTHROPIC_SERVICE_ACCOUNT_ID, plus an identity token in
// ANTHROPIC_IDENTITY_TOKEN or a projected token file in
// ANTHROPIC_IDENTITY_TOKEN_FILE.
const identityTokenFile = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;

const anthropic = createAnthropic({
  federation: {
    identityToken:
      identityTokenFile != null
        ? async () => (await readFile(identityTokenFile, 'utf8')).trim()
        : undefined,
  },
});

run(async () => {
  const result = await generateText({
    model: anthropic('haiku'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  print('Content:', result.content);
  print('Usage:', result.usage);
  print('Finish reason:', result.finishReason);
});

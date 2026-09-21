/**
 * Merges `anthropic-beta` header values into one comma-separated value,
 * dropping blanks and duplicates (case-insensitively, as the API treats
 * beta names). Returns `undefined` when there is nothing to send.
 */
export function mergeAnthropicBetas(
  ...values: Array<string | undefined>
): string | undefined {
  const betas = new Set(
    values
      .flatMap(value => value?.split(',') ?? [])
      .map(beta => beta.trim().toLowerCase())
      .filter(beta => beta !== ''),
  );

  return betas.size > 0 ? Array.from(betas).join(',') : undefined;
}

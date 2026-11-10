/** Contract parsers may add defaults or normalize legacy values. Evidence keeps
 * its original admitted JSON; reject discarded keys without requiring a rewrite. */
export function assertRecoveryPayloadShape(
  original: unknown,
  typed: unknown,
  optionalNulls: readonly string[] = [],
  path = '',
): void {
  if (
    original &&
    typed &&
    typeof original === 'object' &&
    typeof typed === 'object' &&
    !Array.isArray(original) &&
    !Array.isArray(typed)
  ) {
    for (const key of Object.keys(original)) {
      const next = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(typed, key)) {
        if (original[key] === null && optionalNulls.includes(next)) continue;
        throw new Error('Unsupported payload field: ' + next);
      }
      assertRecoveryPayloadShape(
        original[key],
        typed[key],
        optionalNulls,
        next,
      );
    }
  } else if (Array.isArray(original) && Array.isArray(typed)) {
    if (original.length !== typed.length)
      throw new Error('Payload array shape changed: ' + path);
    original.forEach((value, index) =>
      assertRecoveryPayloadShape(
        value,
        typed[index],
        optionalNulls,
        `${path}[${index}]`,
      ),
    );
  }
}

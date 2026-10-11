export function assertExactSourceSet(label, expectedPaths, actualPaths) {
  const expected = [...new Set(expectedPaths)].sort();
  const actual = [...new Set(actualPaths)].sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  if (missing.length || unexpected.length || expectedPaths.length !== expected.length || actualPaths.length !== actual.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(', ')}`);
    if (unexpected.length) details.push(`unexpected: ${unexpected.join(', ')}`);
    if (expectedPaths.length !== expected.length || actualPaths.length !== actual.length) details.push('duplicate path entries present');
    throw new Error(`${label} traced T3 source set differs from source-lock.json (${details.join('; ')})`);
  }
}

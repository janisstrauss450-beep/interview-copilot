import { resolveApiKey, smokeTestApiKey, maskKey } from '../src/main/apiKey.js';

async function main() {
  console.log('── OpenAI API key ──');
  const resolved = await resolveApiKey();
  if (!resolved) {
    console.error('No OpenAI API key found.');
    console.error('Sources checked (in order):');
    console.error('  1. OPENAI_API_KEY env var (from .env or shell)');
    console.error('  2. OS keychain (written by setup window)');
    console.error('  3. Bundled resource (resources/baked-openai-key.txt)');
    console.error('  4. Legacy fallback: ~/ebay-scanner/config.py');
    process.exitCode = 2;
    return;
  }
  console.log(`source:  ${resolved.source}${resolved.sourcePath ? ' (' + resolved.sourcePath + ')' : ''}`);
  console.log(`key:     ${maskKey(resolved.key)}`);
  console.log(`→ GET https://api.openai.com/v1/models ...`);
  const smoke = await smokeTestApiKey(resolved.key);
  if (smoke.ok) {
    console.log(`  OK: HTTP ${smoke.status}, ${smoke.modelCount} models accessible`);
  } else {
    console.error(`  FAIL: HTTP ${smoke.status ?? '?'} ${smoke.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 10;
});

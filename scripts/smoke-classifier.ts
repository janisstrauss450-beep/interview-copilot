import { classifyUtterance } from '../src/main/classifier.js';

interface TestCase {
  text: string;
  expect: 'question_to_candidate' | 'reading_source' | 'other';
}

const CASES: TestCase[] = [
  { text: 'Why did you choose this university?', expect: 'question_to_candidate' },
  { text: 'Tell me about a time you struggled.', expect: 'question_to_candidate' },
  { text: 'Walk me through your reasoning on that.', expect: 'question_to_candidate' },
  { text: 'Describe a project you led.', expect: 'question_to_candidate' },
  { text: 'And why do you think that is?', expect: 'question_to_candidate' },

  { text: 'The author argues that capitalism inevitably leads to monopolies in network industries.', expect: 'reading_source' },
  { text: 'Quantum computing leverages superposition to perform many calculations at once.', expect: 'reading_source' },
  { text: 'The passage states, and I quote, that social norms evolve faster than institutions.', expect: 'reading_source' },

  { text: 'I see, that makes sense.', expect: 'other' },
  { text: 'Hmm.', expect: 'other' },
  { text: 'Can you read the first paragraph for me?', expect: 'other' },
  { text: 'That was a good answer, thank you.', expect: 'other' },
  // Judgment call: this is a preamble that immediately precedes a question.
  // LLM defensibly classifies this as question_to_candidate.
  { text: 'Alright, let me ask you something.', expect: 'question_to_candidate' },

  // Follow-up probe without a question mark — interviewer wants a different example.
  { text: 'Okay, but a different one besides him.', expect: 'question_to_candidate' },
  { text: 'Give me another example.', expect: 'question_to_candidate' },

  // Interviewer paraphrases / checks for understanding. In interview dynamics
  // these invite confirmation + expansion — the candidate is expected to reply.
  { text: "So it's like PayPal, basically.", expect: 'question_to_candidate' },
  { text: 'So if I understand correctly, you ran the team for two years.', expect: 'question_to_candidate' },
  { text: 'Okay, so you chose economics over engineering.', expect: 'question_to_candidate' },

  // Pure acknowledgements should still be "other" — no new info, no paraphrase.
  { text: 'Got it, thanks.', expect: 'other' },
  { text: 'Right, okay.', expect: 'other' },
];

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

async function main() {
  let pass = 0;
  let fail = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    const started = Date.now();
    const result = await classifyUtterance(c.text);
    const ms = Date.now() - started;
    const ok = result.category === c.expect;
    if (ok) pass++;
    else fail++;
    const tag =
      result.category === 'question_to_candidate'
        ? 'Q'
        : result.category === 'reading_source'
          ? 'R'
          : '·';
    rows.push(
      [
        ok ? 'OK  ' : 'FAIL',
        tag,
        pad(result.source, 9),
        pad(`conf=${result.confidence.toFixed(2)}`, 9),
        pad(`${ms}ms`, 7),
        `expected=${c.expect}`,
        `reason="${result.reason}"`,
        '',
        JSON.stringify(c.text.slice(0, 70)),
      ].join('  '),
    );
  }
  console.log(rows.join('\n'));
  console.log(`\n${pass}/${CASES.length} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});

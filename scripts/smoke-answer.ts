import { callChatCompletion, callChatCompletionStream } from '../src/main/openaiClient.js';
import {
  buildAnswerInstructions,
  buildSkeletonInstructions,
  formatUserInput,
} from '../src/main/promptBuilder.js';

const QUESTION = process.argv[2] || 'Why did you choose this university?';

async function main() {
  console.log(`question: ${JSON.stringify(QUESTION)}\n`);

  const SKELETON_MODELS = ['gpt-5.4-mini', 'gpt-5.1-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
  const ANSWER_MODELS = ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-4.1', 'gpt-4o'];

  const t0 = Date.now();
  console.log(`── Skeleton (tries: ${SKELETON_MODELS.join(' → ')}) ──`);
  const skeletonInstructions = await buildSkeletonInstructions();
  const skeletonOut = await callChatCompletion({
    model: SKELETON_MODELS,
    system: skeletonInstructions,
    user: formatUserInput(QUESTION, '') + '\n\nRespond with JSON of this shape: {"bullets": ["…", "…"]}',
    temperature: 0.2,
    maxTokens: 200,
    responseFormat: 'json_object',
  });
  console.log(`raw: ${skeletonOut}`);
  console.log(`(${Date.now() - t0}ms)\n`);

  const t1 = Date.now();
  console.log(`── Answer stream (tries: ${ANSWER_MODELS.join(' → ')}) ──`);
  const answerInstructions = await buildAnswerInstructions();
  const stream = callChatCompletionStream({
    model: ANSWER_MODELS,
    system: answerInstructions,
    user: formatUserInput(QUESTION, ''),
    temperature: 0.6,
    maxTokens: 600,
  });

  let firstTokenAt = 0;
  let total = '';
  for await (const token of stream) {
    if (!firstTokenAt) firstTokenAt = Date.now();
    process.stdout.write(token);
    total += token;
  }
  console.log('');
  console.log(
    `\nfirst token: ${firstTokenAt - t1}ms · total: ${Date.now() - t1}ms · ${total.split(/\s+/).length} words`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { callChatCompletion } from './openaiClient.js';
import type { ClassificationResult, QuestionCategory } from '@shared/types';

const CLASSIFIER_MODEL = 'gpt-4o-mini';

const QUESTION_OPENERS = [
  'what', 'how', 'why', 'when', 'where', 'who', 'which',
  'tell me', 'describe', 'explain', 'walk me through',
  'could you', 'would you', 'can you', 'would you mind',
  'do you', 'are you', 'have you', 'is there', 'is it true',
];

const INVITATIONS = [
  "i'd like to hear",
  'i want to know',
  'talk to me about',
  'let me hear',
];

function heuristic(text: string): ClassificationResult {
  const started = Date.now();
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const done = (partial: Partial<ClassificationResult>): ClassificationResult => ({
    category: partial.category ?? 'other',
    confidence: partial.confidence ?? 0,
    source: 'heuristic',
    reason: partial.reason ?? '',
    latencyMs: Date.now() - started,
    ...partial,
  });

  if (!trimmed) {
    return done({ category: 'other', confidence: 1.0, reason: 'empty' });
  }

  const imperativeAction =
    /^(could|can|would|will)\s+you\s+(read|show|play|open|close|move|press|click|type|write|draw|point|bring|hand|pass|spell|hold|wait|pause|stop|start|scroll|flip|turn)\b/i;
  const isImperativeAction = imperativeAction.test(trimmed);

  if (trimmed.endsWith('?') && !isImperativeAction) {
    return done({ category: 'question_to_candidate', confidence: 0.95, reason: 'terminal ?' });
  }
  if (trimmed.endsWith('?') && isImperativeAction) {
    return done({ category: 'other', confidence: 0.4, reason: 'imperative action (defer to LLM)' });
  }

  for (const opener of QUESTION_OPENERS) {
    const prefix = opener + ' ';
    if (lower.startsWith(prefix) || lower === opener || lower.startsWith(opener + ',')) {
      return done({
        category: 'question_to_candidate',
        confidence: 0.75,
        reason: `opener "${opener}"`,
      });
    }
  }

  for (const invite of INVITATIONS) {
    if (lower.includes(invite)) {
      return done({
        category: 'question_to_candidate',
        confidence: 0.7,
        reason: `invitation "${invite}"`,
      });
    }
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return done({ category: 'other', confidence: 0.4, reason: 'short fragment' });
  }

  return done({ category: 'other', confidence: 0.3, reason: 'declarative default' });
}

const LLM_SYSTEM = `You classify utterances from a university admissions interviewer.

Output only JSON in this exact shape:
{"is_question_to_candidate": bool, "reading_source": bool, "reason": "<short phrase>"}

is_question_to_candidate=true includes ALL of these:
- Direct questions with "?"
- Invitations ("tell me about…", "walk me through…")
- Follow-up probes (may be elided / no "?", e.g. "Okay, but a different one besides him.")
- Hypothetical prompts ("what would you do if…")
- **Paraphrases or checks for understanding** — when the interviewer summarizes what the candidate just said, they expect the candidate to confirm, nuance, or correct. These are conversational prompts in interview dynamics, NOT passive statements.

reading_source=true:
- The interviewer is reading aloud from an article / passage / prompt
- Quoting a source verbatim
- Pure expository background information

Both false (no response needed from candidate):
- Pure acknowledgements (short, no paraphrase): "I see.", "Got it.", "Makes sense.", "Okay."
- **Mechanical instructions** — asking the candidate to perform a non-verbal action (read aloud, wait, pause, move). Key test: is the interviewer asking for new verbal content, or asking for a physical/mechanical action? Asking to read = mechanical. Asking for an example = verbal content = question_to_candidate.
- Fillers: "Hmm.", "Right."
- Interviewer talking to themselves / other people

Examples (input → output):
"So, tell me a little about yourself." → {"is_question_to_candidate": true, "reading_source": false, "reason": "invitation to speak"}
"Quantum computing leverages superposition to perform many calculations at once." → {"is_question_to_candidate": false, "reading_source": true, "reason": "expository statement"}
"I see, that makes sense." → {"is_question_to_candidate": false, "reading_source": false, "reason": "pure acknowledgement"}
"And why do you think that is?" → {"is_question_to_candidate": true, "reading_source": false, "reason": "follow-up question"}
"The source argues, and I quote, that the market rewards..." → {"is_question_to_candidate": false, "reading_source": true, "reason": "quoting source"}
"What would you do if you were in that position?" → {"is_question_to_candidate": true, "reading_source": false, "reason": "hypothetical prompt"}
"Hmm." → {"is_question_to_candidate": false, "reading_source": false, "reason": "filler"}
"Can you read the first paragraph for me?" → {"is_question_to_candidate": false, "reading_source": false, "reason": "mechanical instruction — no verbal content expected"}
"Give me another example." → {"is_question_to_candidate": true, "reading_source": false, "reason": "request for verbal content"}
"Name one more." → {"is_question_to_candidate": true, "reading_source": false, "reason": "request for verbal content"}
"Walk me through your reasoning on that." → {"is_question_to_candidate": true, "reading_source": false, "reason": "invitation to explain"}
"Okay, but a different one besides him." → {"is_question_to_candidate": true, "reading_source": false, "reason": "elided follow-up question"}
"So it's like PayPal, basically." → {"is_question_to_candidate": true, "reading_source": false, "reason": "paraphrase invites confirmation or correction"}
"So if I understand correctly, you ran the team for two years." → {"is_question_to_candidate": true, "reading_source": false, "reason": "summary invites confirmation"}
"Okay, so you chose economics over engineering." → {"is_question_to_candidate": true, "reading_source": false, "reason": "check-for-understanding invites response"}
"Right, so the app is basically for splitting bills." → {"is_question_to_candidate": true, "reading_source": false, "reason": "paraphrase invites confirmation"}
"Got it, thanks." → {"is_question_to_candidate": false, "reading_source": false, "reason": "pure acknowledgement, no prompt"}

Heuristic: if the interviewer's line paraphrases, summarizes, or restates what the candidate probably just said — classify as is_question_to_candidate=true. In interview dynamics, those are implicit invitations to confirm + expand.

Be decisive. Output JSON only — no markdown fences, no preamble.`;

function parseLlmJson(raw: string): { isQ: boolean; isR: boolean; reason: string } | null {
  const cleaned = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      isQ: !!parsed.is_question_to_candidate,
      isR: !!parsed.reading_source,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'llm',
    };
  } catch {
    return null;
  }
}

async function llmTiebreaker(text: string, signal?: AbortSignal): Promise<ClassificationResult> {
  const started = Date.now();
  try {
    const output = await callChatCompletion({
      model: CLASSIFIER_MODEL,
      system: LLM_SYSTEM,
      user: text,
      temperature: 0.1,
      maxTokens: 120,
      responseFormat: 'json_object',
      signal,
    });
    const parsed = parseLlmJson(output);
    if (!parsed) {
      return {
        category: 'other',
        confidence: 0.3,
        source: 'llm',
        reason: `unparseable LLM output`,
        rawLlmOutput: output.slice(0, 200),
        latencyMs: Date.now() - started,
      };
    }
    let category: QuestionCategory;
    if (parsed.isQ) category = 'question_to_candidate';
    else if (parsed.isR) category = 'reading_source';
    else category = 'other';
    return {
      category,
      confidence: parsed.isQ || parsed.isR ? 0.85 : 0.75,
      source: 'llm',
      reason: parsed.reason,
      rawLlmOutput: output.slice(0, 200),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      category: 'other',
      confidence: 0.2,
      source: 'llm',
      reason: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - started,
    };
  }
}

export async function classifyUtterance(
  text: string,
  signal?: AbortSignal,
): Promise<ClassificationResult> {
  const h = heuristic(text);
  if (h.category === 'question_to_candidate' && h.confidence >= 0.9) {
    return h;
  }
  if (h.confidence >= 0.9 && h.category === 'other' && h.reason === 'empty') {
    return h;
  }
  return llmTiebreaker(text, signal);
}

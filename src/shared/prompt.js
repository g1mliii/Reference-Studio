import { DEFAULT_PROMPT } from './constants.js';

const INPUT_RULES = [
  'You will receive exactly two images.',
  'Input 1 is the reference scene image.',
  'Input 2 is the model car image that must replace the car in Input 1.',
  'Wheel and rim color, finish, brightness, and spoke appearance must stay identical to Input 1 and must not be copied from Input 2.',
];

export function buildPrompt({
  basePrompt = DEFAULT_PROMPT,
  carIdentity,
}) {
  const sections = [
    INPUT_RULES.join(' '),
    basePrompt.trim(),
    `Exact car identity from the filename: ${carIdentity}.`,
  ];

  return sections.join('\n\n');
}

export function normalizePrompt(input) {
  const trimmed = (input || '').trim();
  return trimmed || DEFAULT_PROMPT;
}

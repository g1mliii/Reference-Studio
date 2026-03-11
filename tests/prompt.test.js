import { describe, expect, it } from 'vitest';

import { DEFAULT_PROMPT } from '../src/shared/constants.js';
import { buildPrompt, normalizePrompt } from '../src/shared/prompt.js';

describe('shared/prompt', () => {
  it('adds the filename-derived car identity and input rules', () => {
    const prompt = buildPrompt({
      basePrompt: DEFAULT_PROMPT,
      carIdentity: 'blue,911-gt3-rs',
    });

    expect(prompt).toContain('Input 1 is the reference scene image.');
    expect(prompt).toContain('Wheel and rim color, finish, brightness, and spoke appearance');
    expect(prompt).toContain('Exact car identity from the filename: blue,911-gt3-rs.');
  });

  it('falls back to the default prompt when the input is blank', () => {
    expect(normalizePrompt('   ')).toBe(DEFAULT_PROMPT);
  });
});

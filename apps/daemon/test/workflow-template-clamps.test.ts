import { describe, expect, it } from 'vitest';

import { validateTemplate } from '../src/processing/workflow-miner.js';
import { StructuredValidationError } from '../src/llm/structured-prompt-runner.js';
import type { WorkflowTemplateLlm } from '../src/processing/workflow-miner.js';

/**
 * validateTemplate (workflow-miner.ts) is the deterministic gate between raw
 * LLM JSON and insertWorkflow: trim + cap name (120), purpose/expectedOutcome
 * (300), lists cleaned of blanks and capped at 20 items, whitespace-only name
 * rejected with the miner's own error type (its catch branches on instanceof).
 */
describe('workflow template clamps', () => {
  function template(overrides: Partial<WorkflowTemplateLlm> = {}): WorkflowTemplateLlm {
    return {
      name: 'Deploy checklist',
      purpose: 'Ship safely',
      preconditions: ['tests green'],
      stableSteps: ['run ci'],
      variableInputs: ['release tag'],
      expectedOutcome: 'deployed',
      ...overrides,
    };
  }

  it('trims and caps the name at 120 chars without mutating the input', () => {
    const rawName = `  ${'x'.repeat(150)}  `;
    const raw = template({ name: rawName });

    const result = validateTemplate(raw);

    expect(result.name).toHaveLength(120);
    expect(result.name).toBe('x'.repeat(120));
    expect(result.template.name).toBe(result.name);
    // Purity: the raw LLM object is never mutated.
    expect(raw.name).toBe(rawName);
  });

  it('rejects a whitespace-only name with StructuredValidationError', () => {
    const raw = template({ name: '   ' });

    let caught: unknown;
    try {
      validateTemplate(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredValidationError);
    const validationError = caught as StructuredValidationError;
    expect(validationError.initialErrors).toContain('empty template name');
  });

  it('cleans lists: trims, drops empties, caps at exactly 20 items', () => {
    const valid = Array.from({ length: 25 }, (_, i) => `item ${i}`);
    const raw = template({
      preconditions: ['', '   ', 'first', '  spaced  ', ...valid],
      variableInputs: ['', 'only one'],
    });

    const result = validateTemplate(raw);

    expect(result.template.preconditions).toHaveLength(20);
    expect(result.template.preconditions[0]).toBe('first');
    expect(result.template.preconditions[1]).toBe('spaced');
    expect(result.template.preconditions[2]).toBe('item 0');
    expect(result.template.variableInputs).toEqual(['only one']);
  });

  it('trims and caps purpose/expectedOutcome at 300 chars', () => {
    const raw = template({
      purpose: `${'p'.repeat(400)}`,
      expectedOutcome: `  ${'o'.repeat(398)}  `,
    });

    const result = validateTemplate(raw);

    expect(result.purpose).toHaveLength(300);
    expect(result.purpose).toBe('p'.repeat(300));
    expect(result.template.expectedOutcome).toHaveLength(300);
    expect(result.template.expectedOutcome).toBe('o'.repeat(300));
  });
});

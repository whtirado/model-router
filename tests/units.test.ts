import { expect, test } from 'claude-code/testing'

import type { RouterChoice } from '../types'
import {
  chooseByRules,
  costOf,
  dollars,
  escalateChoice,
  floorFollowUp,
  isFollowUp,
  labelOf,
  modelNameOf,
  parseChoice,
  parseVerdict,
  progressText,
  subagentChoice,
  verdictByRules,
} from '../hooks/register'

const OPUS_HIGH: RouterChoice = { model: 'opus', effort: 'high', reason: 'hard', source: 'classifier' }
/** Rounds away floating-point noise in dollar sums. */
const round = (n: number) => Math.round(n * 1e8) / 1e8
const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 }

test('model names: every family, Mythos as Fable, and unknown models', () => {
  expect(modelNameOf('claude-haiku-5-5')).toBe('haiku')
  expect(modelNameOf('claude-mythos-5-1')).toBe('fable')
  expect(modelNameOf('gpt-9')).toBeUndefined()
  expect(labelOf('claude-fable-5-1')).toBe('Fable 5.1')
  expect(labelOf('gpt-9')).toBe('gpt-9')
})

test('prices: unknown models cost nothing, long Haiku prompts cost five times, and 5-minute writes cost less', () => {
  expect(costOf('gpt-9', USAGE, '1h')).toBe(0)
  const longPrompt = { ...USAGE, cache_read_input_tokens: 200_000 }
  // (1000 x 0.1 + 500 x 0.5 + 200,000 x 0.01 + 2000 x 0.2) x 5 / 1M
  expect(round(costOf('claude-haiku-5-5', longPrompt, '1h'))).toBe(0.01375)
  // 1000 x 2 + 500 x 10 + 10,000 x 0.2 + 2000 x 2.5, per million
  expect(round(costOf('claude-sonnet-5-5', USAGE, '5m'))).toBe(0.014)
})

test('the classifier answer is read only when it names a known model and effort', () => {
  expect(parseChoice('no json here')).toBeUndefined()
  expect(parseChoice('{"model":"gpt","effort":"low"}')).toBeUndefined()
  expect(parseChoice('{"model":"sonnet"}')).toBeUndefined()
  expect(parseChoice('{"effort":"low"}')).toBeUndefined()
  expect(parseChoice('{not json}')).toBeUndefined()
  expect(parseChoice('{"model":"Sonnet","effort":"LOW"}')).toEqual({ model: 'sonnet', effort: 'low', reason: 'classifier', source: 'classifier' })
})

test('approvals: blank or punctuation-only text is not one', () => {
  expect(isFollowUp('')).toBe(false)
  expect(isFollowUp('!!!')).toBe(false)
  expect(isFollowUp('Go ahead!')).toBe(true)
})

test('an approval keeps the previous model and effort only when the new choice is lower', () => {
  const lowerEffort: RouterChoice = { model: 'opus', effort: 'low', reason: 'short', source: 'classifier' }
  expect(floorFollowUp(lowerEffort, 'yes', OPUS_HIGH)).toEqual({ model: 'opus', effort: 'high', reason: 'follow-up, kept previous choice', source: 'rules' })
  const higher: RouterChoice = { model: 'fable', effort: 'high', reason: 'harder', source: 'classifier' }
  expect(floorFollowUp(higher, 'yes', OPUS_HIGH)).toBe(higher)
  expect(floorFollowUp(lowerEffort, 'tell me more', OPUS_HIGH)).toBe(lowerEffort)
})

test('the rules: approvals, debugging, short, code, long and everyday prompts', () => {
  expect(chooseByRules('do it', OPUS_HIGH).reason).toBe('follow-up, kept previous choice')
  expect(chooseByRules('fix the login crash').model).toBe('opus')
  expect(chooseByRules('what is this').model).toBe('haiku')
  expect(chooseByRules('const f = () => 1').model).toBe('sonnet')
  const long = chooseByRules(Array.from({ length: 160 }, () => 'word').join(' '))
  expect(long).toEqual({ model: 'opus', effort: 'medium', reason: 'rules: long prompt', source: 'rules', large: true })
  expect(chooseByRules('please write a small script that renames the files in this folder by their date taken').model).toBe('sonnet')
})

test('a Plan subagent runs on its task own model and effort', () => {
  expect(subagentChoice(OPUS_HIGH, 'Plan')).toEqual({ model: 'opus', effort: 'high' })
})

test('the long-task answer is read only when it names a known step', () => {
  expect(parseVerdict('keep going')).toBeUndefined()
  expect(parseVerdict('{"escalate":"panic"}')).toBeUndefined()
  expect(parseVerdict('{oops}')).toBeUndefined()
  expect(parseVerdict('{"escalate":"none"}')).toEqual({ escalate: 'none', subagents: false, reason: 'long task check' })
})

test('the long-task rules: stuck raises effort above Haiku; progressing with subagents changes nothing', () => {
  const stuck = { steps: 30, elapsedMs: 0, toolErrors: 5, subagents: 0 }
  expect(verdictByRules(stuck, 'sonnet').escalate).toBe('effort')
  expect(verdictByRules({ ...stuck, toolErrors: 0, subagents: 2 }, 'sonnet')).toEqual({
    escalate: 'none',
    subagents: false,
    reason: 'rules: long but progressing',
    source: 'rules',
  })
})

test('escalation climbs effort first when asked, then models, and stops at Fable high', () => {
  const sonnetLow: RouterChoice = { model: 'sonnet', effort: 'low', reason: 'r', source: 'classifier' }
  expect(escalateChoice(sonnetLow, 'none', 'x')).toBeUndefined()
  expect(escalateChoice(sonnetLow, 'effort', 'x')?.effort).toBe('medium')
  expect(escalateChoice({ ...sonnetLow, effort: 'high' }, 'effort', 'x')).toMatchObject({ model: 'opus', effort: 'high' })
  expect(escalateChoice({ ...sonnetLow, model: 'fable', effort: 'medium' }, 'model', 'x')).toMatchObject({ model: 'fable', effort: 'high', reason: 'long task: x' })
  expect(escalateChoice({ ...sonnetLow, model: 'fable', effort: 'high' }, 'model', 'x')).toBeUndefined()
})

test('progress and dollars read the way the transcript shows them', () => {
  expect(progressText({ steps: 3, elapsedMs: 90_000, toolErrors: 0, subagents: 0 })).toBe('3 steps, 2 min')
  expect(dollars(0)).toBe('$0')
  expect(dollars(1.234)).toBe('$1.23')
})

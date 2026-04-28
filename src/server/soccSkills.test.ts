import { describe, expect, test } from 'bun:test'
import {
  SOC_SKILL_NAMES,
  appendSoccSkillsToSystemPrompt,
  buildSoccSkillsSystemPrompt,
} from './soccSkills.ts'

describe('SOC Copilot skills prompt', () => {
  test('loads the phase 6 SOC skills and shared references from @vantagesec/socc', async () => {
    const prompt = await buildSoccSkillsSystemPrompt()

    for (const skill of SOC_SKILL_NAMES) {
      expect(prompt).toContain(`## Skill: ${skill}`)
    }
    expect(prompt).toContain('## Reference: output-contract.md')
    expect(prompt).toContain('verdict')
    expect(prompt).toContain('Never fabricate ATT&CK mappings')
  })

  test('appends skills once to an existing system prompt', async () => {
    const once = await appendSoccSkillsToSystemPrompt('Base instructions')
    const twice = await appendSoccSkillsToSystemPrompt(once)

    expect(once).toStartWith('Base instructions')
    expect(twice).toBe(once)
  })
})

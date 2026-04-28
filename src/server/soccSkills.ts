import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOC_SKILL_NAMES = [
  'payload-triage',
  'phishing-analysis',
  'malware-behavior',
  'suspicious-url',
  'soc-generalist',
] as const

const SOC_REFERENCE_FILES = [
  'output-contract.md',
  'evidence-rules.md',
  'ioc-extraction.md',
  'mitre-guidance.md',
] as const

const SKILLS_MARKER = '<!-- socc-plugin:soc-skills:v1 -->'

let promptCache: Promise<string> | null = null

function getSoccPackageRoot(): string {
  const enginePath = fileURLToPath(import.meta.resolve('@vantagesec/socc/engine'))
  return dirname(dirname(enginePath))
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

async function buildSoccSkillsSystemPromptUncached(): Promise<string> {
  const root = getSoccPackageRoot()
  const skills = await Promise.all(
    SOC_SKILL_NAMES.map(async (name) => ({
      name,
      content: await readText(join(root, '.socc', 'skills', name, 'SKILL.md')),
    })),
  )
  const references = await Promise.all(
    SOC_REFERENCE_FILES.map(async (name) => ({
      name,
      content: await readText(join(root, '.socc', 'references', name)),
    })),
  )

  const skillSections = skills
    .map(({ name, content }) => `## Skill: ${name}\n\n${content.trim()}`)
    .join('\n\n')
  const referenceSections = references
    .map(({ name, content }) => `## Reference: ${name}\n\n${content.trim()}`)
    .join('\n\n')

  return `${SKILLS_MARKER}
# SOC Copilot Skills

The following SOC Copilot skills are available in this headless session. Select the most specific matching skill for each analyst request and follow its workflow. If no specialized skill fits, use soc-generalist. Treat the references as operational guidance and do not fabricate reputation, ATT&CK mappings, CVEs, malware families, or external enrichment results.

${skillSections}

# SOC Copilot References

${referenceSections}`.trim()
}

export async function buildSoccSkillsSystemPrompt(): Promise<string> {
  promptCache ??= buildSoccSkillsSystemPromptUncached()
  return promptCache
}

export async function appendSoccSkillsToSystemPrompt(systemPrompt?: string): Promise<string> {
  const base = systemPrompt?.trim()
  if (base?.includes(SKILLS_MARKER)) return base
  const skillsPrompt = await buildSoccSkillsSystemPrompt()
  return base ? `${base}\n\n${skillsPrompt}` : skillsPrompt
}

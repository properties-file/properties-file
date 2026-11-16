/**
 * The rules release notes have to follow, and what checks them. The rules are those of the
 * repository, not of this tool: they are read from `release.config.json` (see
 * {@link readNotesRules}), which says which sections the notes can have and in which order,
 * what must not appear in them, and gives an example to show when they are not followed.
 *
 * Only the form is checked. What the notes say, and whether it is true, is for whoever writes
 * them (see `docs/release-notes-guidelines.md`).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

/** The file the rules are read from, at the root of the repository. */
const CONFIG_FILE_NAME = 'release.config.json'

/** Matches a Markdown heading, capturing its level marker and its title. */
const REGEX_HEADING = /^(?<marker>#{1,6})\s+(?<title>\S.*)$/

/** Matches the line that opens or closes a fenced code block, at any indentation. */
const REGEX_CODE_FENCE = /^\s*(?:```|~~~)/

/** Matches an item that was left as a placeholder instead of being written. */
const REGEX_PLACEHOLDER = /^(?:…|\.{3}|todo|tbd)\.?$/i

/** Something the notes must not contain. */
type ForbiddenPattern = {
  /** The regular expression that finds it, as text. */
  pattern: string
  /** The flags of the regular expression, when it needs any. */
  flags?: string
  /** Why it does not belong in release notes, shown when it is found. */
  reason: string
}

/** The rules of the release notes of a repository. */
export type NotesRules = {
  /** The titles of the sections the notes can have, in the order they go in. */
  sections: string[]
  /** The section a major release must have, and only a major release can have. */
  breakingSection?: string
  /** What the notes must not contain, outside code. */
  forbidden: ForbiddenPattern[]
  /** Notes that follow the rules, shown when notes do not. */
  example: string
}

/** What the rules need to know about the release the notes are for. */
export type NotesContext = {
  /** The version being released. */
  version: string
  /** Whether that version is a major one. */
  isMajor: boolean
}

/** A rule the notes do not follow. */
export type NotesProblem = {
  /** The number of the line the problem is on (1 for the first), or `undefined` for the notes as a whole. */
  lineNumber: number | undefined
  /** The line the problem is on, or an empty string for the notes as a whole. */
  line: string
  /** What is wrong, and what to write instead. */
  message: string
}

/**
 * Check that a value read from the configuration is a list of strings.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is an array whose elements are all strings.
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((element) => typeof element === 'string')

/**
 * Check that a value read from the configuration describes something forbidden.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has a `pattern`, a `reason`, and at most `flags`, all strings.
 */
const isForbiddenPattern = (value: unknown): value is ForbiddenPattern =>
  typeof value === 'object' &&
  value !== null &&
  'pattern' in value &&
  typeof value.pattern === 'string' &&
  'reason' in value &&
  typeof value.reason === 'string' &&
  (!('flags' in value) || typeof value.flags === 'string')

/**
 * Check that a value read from the configuration lists things that are forbidden.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is an array whose elements all describe something forbidden.
 */
const isForbiddenPatternArray = (value: unknown): value is ForbiddenPattern[] =>
  Array.isArray(value) && value.every((element) => isForbiddenPattern(element))

/**
 * Build the regular expression that finds something forbidden.
 *
 * @param forbidden - What is forbidden.
 *
 * @returns The expression, without the flags that make one remember where its last match
 *   ended: it is tested against one line after another.
 *
 * @throws If the pattern or its flags are not those of a regular expression.
 */
const compileForbiddenPattern = (forbidden: ForbiddenPattern): RegExp =>
  new RegExp(forbidden.pattern, (forbidden.flags ?? '').replaceAll(/[gy]/g, ''))

/**
 * Read the rules of the release notes of a repository from its `release.config.json`.
 *
 * @param directoryPath - The root directory of the repository.
 *
 * @returns The rules, or `undefined` when the repository has no `release.config.json` or when
 *   that file says nothing about the notes: they are then not checked.
 *
 * @throws If the file is not JSON, if its `notes` do not have the expected form, or if
 *   something they forbid is not a regular expression.
 */
export const readNotesRules = (directoryPath: string): NotesRules | undefined => {
  const configPath = path.join(directoryPath, CONFIG_FILE_NAME)
  if (!existsSync(configPath)) {
    return undefined
  }
  const config = noThrow((): unknown => JSON.parse(readFileSync(configPath, 'utf8')))
  if (isNormalizedError(config)) {
    throw new Error(`🚨 ${CONFIG_FILE_NAME} is not valid JSON: ${config.message}`)
  }
  if (typeof config !== 'object' || config === null || !('notes' in config)) {
    return undefined
  }
  const { notes } = config
  const forbidden: unknown =
    typeof notes === 'object' && notes !== null && 'forbidden' in notes ? notes.forbidden : []
  if (
    typeof notes !== 'object' ||
    notes === null ||
    !('sections' in notes) ||
    !isStringArray(notes.sections) ||
    notes.sections.length === 0 ||
    !('example' in notes) ||
    typeof notes.example !== 'string' ||
    ('breakingSection' in notes &&
      !(
        typeof notes.breakingSection === 'string' && notes.sections.includes(notes.breakingSection)
      )) ||
    !isForbiddenPatternArray(forbidden)
  ) {
    throw new Error(
      `🚨 the "notes" of ${CONFIG_FILE_NAME} must have "sections" (titles, at least one), an ` +
        '"example" (text), and optionally a "breakingSection" (one of the sections) and ' +
        '"forbidden" (a list of { "pattern", "reason", "flags"? })'
    )
  }
  for (const forbiddenPattern of forbidden) {
    const expression = noThrow(() => compileForbiddenPattern(forbiddenPattern))
    if (isNormalizedError(expression)) {
      throw new Error(
        `🚨 the "forbidden" pattern ${JSON.stringify(forbiddenPattern.pattern)} of ${CONFIG_FILE_NAME} ` +
          `is not a regular expression: ${expression.message}`
      )
    }
  }
  return {
    sections: notes.sections,
    breakingSection:
      'breakingSection' in notes && typeof notes.breakingSection === 'string'
        ? notes.breakingSection
        : undefined,
    forbidden,
    example: notes.example,
  }
}

/**
 * Find every rule that release notes do not follow.
 *
 * @param notes - The release notes, with Unix line endings.
 * @param rules - The rules of the repository.
 * @param context - The release the notes are for.
 *
 * @returns The problems, in the order of the lines they are on; those about the notes as a
 *   whole come last. Empty when the notes follow the rules.
 */
export const findNotesProblems = (
  notes: string,
  rules: NotesRules,
  context: NotesContext
): NotesProblem[] => {
  const problems: NotesProblem[] = []
  const headingList = rules.sections.map((section) => `"### ${section}"`).join(', ')
  const forbiddenPatterns = rules.forbidden.map((forbidden) => ({
    expression: compileForbiddenPattern(forbidden),
    reason: forbidden.reason,
  }))

  // The section the current line is in: whether its heading is one the rules allow, the line
  // of that heading and how many items it has so far.
  let section:
    { isAllowed: boolean; lineNumber: number; line: string; itemCount: number } | undefined
  let lastSectionIndex = -1
  let hasBreakingSection = false
  let isInCodeBlock = false

  /**
   * Record the current section as empty if it has no item, when it ends. A section whose
   * heading is not allowed already has a problem, and is not given a second one.
   */
  const closeSection = (): void => {
    if (section?.isAllowed === true && section.itemCount === 0) {
      problems.push({
        lineNumber: section.lineNumber,
        line: section.line,
        message:
          'This section has no item. Give it at least one ("- …"), or leave the section out.',
      })
    }
  }

  for (const [index, line] of notes.split('\n').entries()) {
    if (REGEX_CODE_FENCE.test(line)) {
      isInCodeBlock = !isInCodeBlock
      continue
    }
    if (isInCodeBlock || line.trim() === '') {
      continue
    }
    const lineNumber = index + 1

    const heading = REGEX_HEADING.exec(line)?.groups
    if (heading !== undefined) {
      const sectionIndex =
        heading.marker === '###' ? rules.sections.indexOf(heading.title.trimEnd()) : -1
      closeSection()
      if (sectionIndex === -1) {
        problems.push({
          lineNumber,
          line,
          message: `The only headings the notes can have are ${headingList}, written exactly so.`,
        })
        // What follows is checked as the content of a section, so that one heading to correct
        // is not reported again for each line under it.
        section = { isAllowed: false, lineNumber, line, itemCount: 0 }
        continue
      }
      if (sectionIndex <= lastSectionIndex) {
        problems.push({
          lineNumber,
          line,
          message: `The sections go in this order, each at most once: ${headingList}.`,
        })
      }
      lastSectionIndex = Math.max(lastSectionIndex, sectionIndex)
      hasBreakingSection ||= rules.sections[sectionIndex] === rules.breakingSection
      section = { isAllowed: true, lineNumber, line, itemCount: 0 }
      continue
    }

    if (section === undefined) {
      problems.push({
        lineNumber,
        line,
        message: `The notes start with one of the headings ${headingList}: everything is in a section.`,
      })
    } else if (line.startsWith('- ')) {
      section.itemCount++
      if (REGEX_PLACEHOLDER.test(line.slice(2).trim())) {
        problems.push({
          lineNumber,
          line,
          message: 'This item is a placeholder. Write what changed for the user, or remove it.',
        })
      }
    } else if (!/^\s/.test(line)) {
      problems.push({
        lineNumber,
        line,
        message:
          'Everything in a section is a list item: start the line with "- ", or indent it to ' +
          'continue the item above.',
      })
    }

    // What is forbidden is looked for in the text, not in the code it quotes.
    const text = line.replaceAll(/`[^`]*`/g, '')
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.expression.test(text)) {
        problems.push({ lineNumber, line, message: forbidden.reason })
      }
    }
  }
  closeSection()

  if (rules.breakingSection !== undefined && hasBreakingSection !== context.isMajor) {
    problems.push({
      lineNumber: undefined,
      line: '',
      message: context.isMajor
        ? `${context.version} is a major version: its notes need a "### ${rules.breakingSection}" section saying what breaks.`
        : `The notes have a "### ${rules.breakingSection}" section, but ${context.version} is not a major version. A change that breaks existing code needs a major version.`,
    })
  }
  return problems
}

/**
 * Describe the rules release notes do not follow, with an example of notes that do.
 *
 * @param problems - The problems found in the notes (at least one).
 * @param rules - The rules of the repository.
 *
 * @returns The message to show to whoever wrote the notes.
 */
export const describeNotesProblems = (problems: NotesProblem[], rules: NotesRules): string =>
  [
    `🚨 the release notes do not follow the rules of ${CONFIG_FILE_NAME} ` +
      `(${String(problems.length)} ${problems.length === 1 ? 'problem' : 'problems'}):`,
    '',
    ...problems.flatMap((problem, index) => [
      problem.lineNumber === undefined
        ? `   ${String(index + 1)}. the notes as a whole`
        : `   ${String(index + 1)}. line ${String(problem.lineNumber)}: ${problem.line}`,
      `      ${problem.message}`,
    ]),
    '',
    '   Notes in the expected form:',
    '',
    ...rules.example
      .trimEnd()
      .split('\n')
      .map((line) => (line === '' ? '' : `      ${line}`)),
  ].join('\n')

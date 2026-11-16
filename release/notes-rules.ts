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

import { BYTE_ORDER_MARK, readCodeBlockLines } from './changelog'

/** The file the rules are read from, at the root of the repository. */
const CONFIG_FILE_NAME = 'release.config.json'

/** What the `notes` of the file can have. */
const NOTES_KEYS = [
  'sections',
  'breakingSection',
  'featureSection',
  'forbidden',
  'example',
  'majorExample',
]

/** How much of a line is quoted with its problems, at most. */
const QUOTED_LINE_LENGTH = 120

/**
 * Matches a line Markdown reads as a heading, at the beginning of the line or after up to three
 * spaces, capturing its indentation, its level marker and its title.
 */
const REGEX_HEADING = /^(?<indentation> {0,3})(?<marker>#{1,6})(?:\s+(?<title>\S.*)?)?$/

/** Matches a line written as a heading without the space Markdown needs after the marker. */
const REGEX_HEADING_WITHOUT_SPACE = /^#{1,6}[A-Z]/i

/** Matches the closing marker a heading can end with (`### Title ###`). */
const REGEX_HEADING_CLOSING = /\s+#+\s*$/

/** Matches a line that makes a heading of the line above it, or draws a rule. */
const REGEX_UNDERLINE = /^\s*(?:=+|-{2,}|\*{3,}|_{3,})\s*$/

/** Matches a line that starts a list item with another marker than `- `. */
const REGEX_OTHER_LIST_MARKER = /^(?:[*+]|\d+[.)])\s/

/** Matches an item that was left as a placeholder instead of being written. */
const REGEX_PLACEHOLDER = /^(?:…|\.{3}|todo|tbd)\.?$/i

/** Matches inline code, between as many backticks as it starts with. */
const REGEX_INLINE_CODE = /(?<fence>`+).*?\k<fence>/g

/** Something the notes must not contain. */
type ForbiddenPattern = {
  /** The regular expression that finds it, as text. */
  pattern: string
  /** The flags of the regular expression, when it needs any. */
  flags?: string
  /** Why it does not belong in release notes, shown when it is found. */
  reason: string
  /** Whether it is also looked for in inline code (`like this`), where most things are allowed. */
  inCode?: boolean
}

/** The rules of the release notes of a repository. */
export type NotesRules = {
  /** The titles of the sections the notes can have, in the order they go in. */
  sections: string[]
  /** The section a major release must have, and only a major release can have. */
  breakingSection?: string
  /** The section a patch release cannot have: what it lists needs a minor version. */
  featureSection?: string
  /** What the notes must not contain, outside code. */
  forbidden: ForbiddenPattern[]
  /** Notes that follow the rules, shown when notes do not. */
  example: string
  /** Notes of a major release that follow the rules, shown when those of one do not. */
  majorExample?: string
}

/** What a release is, by the part of the version it changes. */
export type ReleaseLevel = 'major' | 'minor' | 'patch'

/** What the rules need to know about the release the notes are for. */
export type NotesContext = {
  /** The version being released. */
  version: string
  /** What the release is, or `undefined` to leave out the rules that depend on it. */
  level: ReleaseLevel | undefined
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
 * Tell what a release is from the version it starts from and the one it makes.
 *
 * @param currentVersion - The version released before, in the `major.minor.patch` form.
 * @param version - The version being released, in the same form.
 *
 * @returns `major` when the first number changes, `minor` when the second one does, and
 *   `patch` otherwise: `5.0.7` to `6.1.0` is a major release.
 */
export const getReleaseLevel = (currentVersion: string, version: string): ReleaseLevel => {
  const [currentMajor, currentMinor] = currentVersion.split('.', 2)
  const [major, minor] = version.split('.', 2)
  if (major !== currentMajor) {
    return 'major'
  }
  return minor === currentMinor ? 'patch' : 'minor'
}

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
    isInCode: forbidden.inCode === true,
  }))

  // The section the current line is in: whether its heading is one the rules allow, the line
  // of that heading, how many items it has so far, and whether one of its lines has a problem
  // of form.
  let section:
    | {
        isAllowed: boolean
        lineNumber: number
        line: string
        itemCount: number
        hasProblem: boolean
      }
    | undefined
  // What the lines seen so far say about the notes as a whole.
  const seen = { lastSectionIndex: -1, hasBreakingSection: false, hasTextBeforeSections: false }

  /**
   * Record a problem of form on a line, in the section the line is in.
   *
   * @param lineNumber - Where the line is in the notes (1 for the first line).
   * @param line - What the line says.
   * @param message - What is wrong, and what to write instead.
   */
  const addFormProblem = (lineNumber: number, line: string, message: string): void => {
    problems.push({ lineNumber, line, message })
    if (section !== undefined) {
      section.hasProblem = true
    }
  }

  /**
   * Record the current section as empty if it has no item, when it ends. A section whose
   * heading or lines already have a problem is not given this one: correcting those is what
   * gives it its items.
   */
  const closeSection = (): void => {
    if (section?.isAllowed === true && section.itemCount === 0 && !section.hasProblem) {
      problems.push({
        lineNumber: section.lineNumber,
        line: section.line,
        message:
          'This section has no item. Give it at least one ("- …"), or leave the section out.',
      })
    }
  }

  /**
   * Check the heading of a section the rules allow: its place, and the release it goes with.
   *
   * @param lineNumber - Where the heading is in the notes (1 for the first line).
   * @param line - The heading, as it is written.
   * @param sectionIndex - The place of the section in the order of the rules.
   */
  const checkSectionHeading = (lineNumber: number, line: string, sectionIndex: number): void => {
    const title = rules.sections[sectionIndex]
    if (sectionIndex <= seen.lastSectionIndex) {
      problems.push({
        lineNumber,
        line,
        message: `The sections go in this order, each at most once: ${headingList}.`,
      })
    }
    seen.lastSectionIndex = Math.max(seen.lastSectionIndex, sectionIndex)
    if (title === rules.breakingSection) {
      seen.hasBreakingSection = true
      if (context.level === 'minor' || context.level === 'patch') {
        problems.push({
          lineNumber,
          line,
          message: `${context.version} is not a new major version, so its notes cannot have this section. A change that breaks existing code needs a major version.`,
        })
      }
    }
    if (title === rules.featureSection && context.level === 'patch') {
      problems.push({
        lineNumber,
        line,
        message: `${context.version} is a patch version, so its notes cannot have this section. Something new for users needs a minor version.`,
      })
    }
  }

  /**
   * Check a line that is, or was meant as, a heading, and start its section.
   *
   * @param lineNumber - Where the heading is in the notes (1 for the first line).
   * @param line - The heading, as it is written.
   * @param heading - What the line has of a heading: its indentation, its level marker and
   *   its title, or `undefined` when it has no space after its marker.
   */
  const checkHeading = (
    lineNumber: number,
    line: string,
    heading: Record<string, string | undefined> | undefined
  ): void => {
    const title = (heading?.title ?? '').replace(REGEX_HEADING_CLOSING, '').trim()
    const sectionIndex =
      heading?.indentation === '' && heading.marker === '###' ? rules.sections.indexOf(title) : -1
    closeSection()
    // What follows a heading that is not allowed is still checked as the content of a
    // section, so that one heading to correct is not reported again for each line under it.
    section = { isAllowed: sectionIndex !== -1, lineNumber, line, itemCount: 0, hasProblem: false }
    if (sectionIndex !== -1) {
      checkSectionHeading(lineNumber, line, sectionIndex)
      return
    }
    const allowedHeadings = `The only headings the notes can have are ${headingList}`
    if (heading === undefined) {
      problems.push({
        lineNumber,
        line,
        message: `A heading needs a space after its "#" marks. ${allowedHeadings}.`,
      })
    } else if (heading.indentation === '') {
      problems.push({ lineNumber, line, message: `${allowedHeadings}, written exactly so.` })
    } else {
      problems.push({
        lineNumber,
        line,
        message: `Markdown reads this line as a heading, and a heading starts at the beginning of its line. ${allowedHeadings}.`,
      })
    }
  }

  /**
   * Check a line that is neither blank, a heading, nor in a code block: that it is, or
   * continues, a list item of a section.
   *
   * @param lineNumber - Where the line is in the notes (1 for the first line).
   * @param line - What the line says.
   */
  const checkContentLine = (lineNumber: number, line: string): void => {
    if (section === undefined) {
      // Said once: every line before the first heading has the same problem.
      if (!seen.hasTextBeforeSections) {
        seen.hasTextBeforeSections = true
        addFormProblem(
          lineNumber,
          line,
          `The notes start with one of the headings ${headingList}: this line, and any other before the first heading, is not in a section.`
        )
      }
    } else if (REGEX_UNDERLINE.test(line)) {
      addFormProblem(
        lineNumber,
        line,
        'Markdown reads this line as a rule, or as making a heading of the line above it. ' +
          `Neither is used in the notes: remove it. The only headings are ${headingList}.`
      )
    } else if (line.trimEnd() === '-' || line.startsWith('- ')) {
      section.itemCount++
      const item = line.slice(1).trim()
      if (item === '') {
        addFormProblem(
          lineNumber,
          line,
          'This item is empty. Write what changed for the user, or remove it.'
        )
      } else if (REGEX_PLACEHOLDER.test(item)) {
        addFormProblem(
          lineNumber,
          line,
          'This item is a placeholder. Write what changed for the user, or remove it.'
        )
      }
    } else if (/^\s/.test(line)) {
      if (section.itemCount === 0) {
        addFormProblem(
          lineNumber,
          line,
          'This line is indented, but no item above it is there to continue. An item starts ' +
            'at the beginning of its line, with "- ".'
        )
      }
    } else if (REGEX_OTHER_LIST_MARKER.test(line)) {
      addFormProblem(
        lineNumber,
        line,
        'An item starts with "- ": the other list markers ("*", "+", "1.") are not used.'
      )
    } else {
      addFormProblem(
        lineNumber,
        line,
        'Everything in a section is a list item: start the line with "- ", or indent it to ' +
          'continue the item above.'
      )
    }
  }

  const lines = notes.split('\n')
  const codeBlockLines = readCodeBlockLines(lines)
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const codeBlockLine = codeBlockLines[index]

    if (codeBlockLine === 'opening') {
      if (section === undefined || section.itemCount === 0 || !/^\s/.test(line)) {
        addFormProblem(
          lineNumber,
          line,
          'A code block belongs to a list item: indent it, with what it contains, under the ' +
            'item it illustrates.'
        )
      }
      if (!codeBlockLines.includes('closing', index)) {
        problems.push({
          lineNumber,
          line,
          message:
            'This code block is never closed: end it with a line like this one, at the same ' +
            'indentation.',
        })
      }
    }
    if (codeBlockLine !== 'outside' || line.trim() === '') {
      continue
    }

    const heading = REGEX_HEADING.exec(line)?.groups
    if (heading !== undefined || REGEX_HEADING_WITHOUT_SPACE.test(line)) {
      checkHeading(lineNumber, line, heading)
      continue
    }

    // What is forbidden comes first: when a line has to go, that is the thing to know about
    // it. Most of it is looked for in the text, not in the code the text quotes.
    const text = line.replaceAll(REGEX_INLINE_CODE, '')
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.expression.test(forbidden.isInCode ? line : text)) {
        problems.push({ lineNumber, line, message: forbidden.reason })
      }
    }
    checkContentLine(lineNumber, line)
  }
  closeSection()

  if (
    rules.breakingSection !== undefined &&
    context.level === 'major' &&
    !seen.hasBreakingSection
  ) {
    problems.push({
      lineNumber: undefined,
      line: '',
      message: `${context.version} is a new major version: its notes need a "### ${rules.breakingSection}" section saying what breaks.`,
    })
  }
  // In the order of the lines (a section without an item is only known when it ends), with
  // what is about the notes as a whole last. The problems of a same line stay as they were
  // found.
  return problems.toSorted(
    (first, second) =>
      (first.lineNumber ?? Number.MAX_SAFE_INTEGER) - (second.lineNumber ?? Number.MAX_SAFE_INTEGER)
  )
}

/**
 * Describe the rules release notes do not follow, with an example of notes that do.
 *
 * @param problems - The problems found in the notes (at least one), in the order of their
 *   lines.
 * @param rules - The rules of the repository.
 * @param context - The release the notes are for.
 *
 * @returns The message to show to whoever wrote the notes: each line at fault once, with
 *   everything that is wrong with it, then the example.
 */
export const describeNotesProblems = (
  problems: NotesProblem[],
  rules: NotesRules,
  context: NotesContext
): string => {
  // The problems of a same line, together.
  const places: { lineNumber: number | undefined; line: string; messages: string[] }[] = []
  for (const problem of problems) {
    const lastPlace = places.at(-1)
    if (lastPlace !== undefined && lastPlace.lineNumber === problem.lineNumber) {
      lastPlace.messages.push(problem.message)
    } else {
      places.push({
        lineNumber: problem.lineNumber,
        line: problem.line,
        messages: [problem.message],
      })
    }
  }
  const example =
    context.level === 'major' && rules.majorExample !== undefined
      ? rules.majorExample
      : rules.example
  return [
    `🚨 the release notes do not follow the rules of ${CONFIG_FILE_NAME} ` +
      `(${String(places.length)} ${places.length === 1 ? 'place' : 'places'} to correct):`,
    '',
    ...places.flatMap((place, index) => [
      place.lineNumber === undefined
        ? `   ${String(index + 1)}. the notes as a whole`
        : `   ${String(index + 1)}. line ${String(place.lineNumber)}: ${
            place.line.length > QUOTED_LINE_LENGTH
              ? `${place.line.slice(0, QUOTED_LINE_LENGTH)}…`
              : place.line
          }`,
      ...place.messages.map((message) => `      ${message}`),
    ]),
    '',
    '   Notes in the expected form:',
    '',
    ...example
      .trimEnd()
      .split('\n')
      .map((line) => (line === '' ? '' : `      ${line}`)),
  ].join('\n')
}

/**
 * Make the error of a `release.config.json` that cannot be used.
 *
 * @param message - What is wrong with the file, and what it should have instead.
 *
 * @returns The error to throw.
 */
const createConfigError = (message: string): Error =>
  new Error(`🚨 ${CONFIG_FILE_NAME}: ${message}`)

/**
 * Check that a value read from the configuration is an object with properties.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is an object that is neither `null` nor an array.
 */
const isConfigObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Check that a value read from the configuration is a list of section titles.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is an array of different strings, at least one, none empty or
 *   padded with spaces.
 */
const isSectionList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (element) => typeof element === 'string' && element !== '' && element.trim() === element
  ) &&
  new Set(value).size === value.length

/**
 * Check that a value read from the configuration describes something forbidden.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has a `pattern` and a `reason`, both text that is not empty,
 *   and at most `flags` (a string) and `inCode` (a boolean).
 */
const isForbiddenPattern = (value: unknown): value is ForbiddenPattern =>
  isConfigObject(value) &&
  typeof value.pattern === 'string' &&
  value.pattern !== '' &&
  typeof value.reason === 'string' &&
  value.reason.trim() !== '' &&
  (value.flags === undefined || typeof value.flags === 'string') &&
  (value.inCode === undefined || typeof value.inCode === 'boolean') &&
  Object.keys(value).every((key) => ['pattern', 'reason', 'flags', 'inCode'].includes(key))

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
 * Read a property of the configuration that can name one of the sections.
 *
 * @param notes - The `notes` of the configuration.
 * @param name - Which of the properties to read.
 * @param sections - The titles of the sections.
 *
 * @returns The title the property gives, or `undefined` when the configuration does not have
 *   the property.
 *
 * @throws If what the property gives is not the title of a section.
 */
const readSectionProperty = (
  notes: Record<string, unknown>,
  name: 'breakingSection' | 'featureSection',
  sections: string[]
): string | undefined => {
  const value = notes[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !sections.includes(value)) {
    throw createConfigError(`"notes.${name}" must be one of the titles of "notes.sections"`)
  }
  return value
}

/**
 * Read a property of the configuration that gives an example of notes.
 *
 * @param notes - The `notes` of the configuration.
 * @param name - Which of the properties to read.
 *
 * @returns The example, or `undefined` when the configuration does not have the property.
 *
 * @throws If what the property gives is not text, or is empty.
 */
const readExampleProperty = (
  notes: Record<string, unknown>,
  name: 'example' | 'majorExample'
): string | undefined => {
  const value = notes[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw createConfigError(
      `"notes.${name}" must be release notes that follow the rules, as text: they are shown ` +
        'when notes do not follow them'
    )
  }
  return value
}

/**
 * Check that an example of the configuration follows the rules it is given with: it is what
 * is shown to someone whose notes are refused.
 *
 * @param name - Which example of the configuration this is.
 * @param example - The example, or `undefined` when the configuration does not have it.
 * @param rules - The rules of the configuration.
 * @param level - The release the example is shown for.
 *
 * @throws If the example does not follow the rules.
 */
const assertExampleFollowsRules = (
  name: 'example' | 'majorExample',
  example: string | undefined,
  rules: NotesRules,
  level: ReleaseLevel
): void => {
  const problem =
    example === undefined
      ? undefined
      : findNotesProblems(example.trimEnd(), rules, { version: 'The version', level }).at(0)
  if (problem !== undefined) {
    throw createConfigError(
      `"notes.${name}" does not follow the rules of the same file` +
        `${problem.lineNumber === undefined ? '' : ` (line ${String(problem.lineNumber)}: ${problem.line})`}: ` +
        problem.message
    )
  }
}

/**
 * Read the rules of the release notes of a repository from its `release.config.json`.
 *
 * @param directoryPath - The root directory of the repository.
 *
 * @returns The rules, or `undefined` when the repository has no `release.config.json` or when
 *   that file has no `notes`: they are then not checked.
 *
 * @throws If the file is not a JSON object, if it or its `notes` have something that is not
 *   expected or not in the expected form, if something they forbid is not a regular
 *   expression, or if an example they give does not follow them. The error names what is
 *   wrong.
 */
export const readNotesRules = (directoryPath: string): NotesRules | undefined => {
  const configPath = path.join(directoryPath, CONFIG_FILE_NAME)
  if (!existsSync(configPath)) {
    return undefined
  }
  const content = readFileSync(configPath, 'utf8')
  const config = noThrow((): unknown =>
    JSON.parse(content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content)
  )
  if (isNormalizedError(config)) {
    throw createConfigError(`the file is not valid JSON (${config.message})`)
  }
  if (!isConfigObject(config)) {
    throw createConfigError('the file must be a JSON object, with the rules under "notes"')
  }
  // A key that is not known is refused, here and in the notes: a misspelled one would
  // otherwise turn a rule off without a word.
  const unknownKey = Object.keys(config).find((key) => key !== 'notes')
  if (unknownKey !== undefined) {
    throw createConfigError(`"${unknownKey}" is not a key of the file: the only one is "notes"`)
  }
  const { notes } = config
  if (notes === undefined) {
    return undefined
  }
  if (!isConfigObject(notes)) {
    throw createConfigError('"notes" must be an object')
  }
  const unknownNotesKey = Object.keys(notes).find((key) => !NOTES_KEYS.includes(key))
  if (unknownNotesKey !== undefined) {
    throw createConfigError(
      `"notes.${unknownNotesKey}" is not a key of the notes: these are ` +
        NOTES_KEYS.map((key) => `"${key}"`).join(', ')
    )
  }
  const { sections, forbidden = [] } = notes
  if (!isSectionList(sections)) {
    throw createConfigError(
      '"notes.sections" must list the titles of the sections: at least one, all different, ' +
        'none empty or with spaces around it'
    )
  }
  if (!isForbiddenPatternArray(forbidden)) {
    throw createConfigError(
      '"notes.forbidden" must be a list of { "pattern", "reason", "flags"?, "inCode"? }, ' +
        'where the pattern and the reason are text that is not empty'
    )
  }
  for (const forbiddenPattern of forbidden) {
    const expression = noThrow(() => compileForbiddenPattern(forbiddenPattern))
    if (isNormalizedError(expression)) {
      throw createConfigError(
        `the "notes.forbidden" pattern ${JSON.stringify(forbiddenPattern.pattern)} is not a ` +
          `regular expression (${expression.message})`
      )
    }
  }
  const example = readExampleProperty(notes, 'example')
  if (example === undefined) {
    throw createConfigError(
      '"notes.example" is missing: release notes that follow the rules, shown when notes do not'
    )
  }
  const majorExample = readExampleProperty(notes, 'majorExample')
  const rules = {
    sections,
    breakingSection: readSectionProperty(notes, 'breakingSection', sections),
    featureSection: readSectionProperty(notes, 'featureSection', sections),
    forbidden,
    example,
    majorExample,
  }
  // The example is shown for the releases that are not major ones, so it is checked as the
  // notes of a minor release, which can have every section but the breaking changes.
  assertExampleFollowsRules('example', example, rules, 'minor')
  assertExampleFollowsRules('majorExample', majorExample, rules, 'major')
  return rules
}

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

import {
  BYTE_ORDER_MARK,
  findNotesHazards,
  readCodeBlockLines,
  REGEX_INLINE_CODE,
} from './changelog'

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
  'sectionAliases',
]

/** What a forbidden pattern of the file can have. */
const FORBIDDEN_KEYS = ['pattern', 'reason', 'flags', 'inCode']

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

/** Matches a line that makes a heading of the line of text above it. */
const REGEX_HEADING_UNDERLINE = /^(?:=+|-{2,})\s*$/

/** Matches what a heading can end with that is not part of its title. */
const REGEX_HEADING_ENDING = /[\s:.]+$/

/** Matches the title of a heading that is a version, as the heading of an entry is. */
const REGEX_VERSION_TITLE = /^\[?v?\d+\.\d+\.\d+/

/** Matches a line that starts a list item with another marker than `- `. */
const REGEX_OTHER_LIST_MARKER = /^(?:[*+]|\d+[.)])\s/

/** Matches an item that was left as a placeholder instead of being written. */
const REGEX_PLACEHOLDER =
  /^(?:(?:…|\.{3})\.?$|(?:todo|tbd|wip|xxx|none|n\/a|-+)[\s.]*$|(?:todo|tbd):|\[[^\]]*\]$)/i

/** Matches the marks of emphasis and of inline code, which a placeholder can be wrapped in. */
const REGEX_EMPHASIS = /[*_`]/g

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
  /**
   * Other titles the sections are known by elsewhere, each with the title of its section: a
   * heading with one of them is told which heading to write.
   */
  sectionAliases?: Record<string, string>
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
 *   `patch` otherwise: `5.0.7` to `6.1.0` is a major release. Versions before `1.0.0` are
 *   read in the same way, although a minor one can break existing code there: `0.5.0` to
 *   `0.6.0` is a minor release.
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
 * Put a text on one line, with single spaces: how two texts are compared whatever their
 * line breaks and their indentation.
 *
 * @param text - What to put on one line.
 *
 * @returns The text without spaces around it, and with one space for each run of them.
 */
const collapseSpaces = (text: string): string => text.trim().replaceAll(/\s+/g, ' ')

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
  const lines = notes.split('\n')
  const codeBlockLines = readCodeBlockLines(lines)
  const headingList = rules.sections.map((section) => `"### ${section}"`).join(', ')
  const forbiddenPatterns = rules.forbidden.map((forbidden) => ({
    expression: compileForbiddenPattern(forbidden),
    reason: forbidden.reason,
    isInCode: forbidden.inCode === true,
  }))
  // The items of the examples: they show the form, and say nothing of a release.
  // Each one whole, on one line: a copy can be wrapped in another way.
  const exampleItems = [rules.example, rules.majorExample ?? ''].flatMap((example) =>
    example
      .split(/\n(?=- )/)
      .filter((item) => item.startsWith('- '))
      // An item ends before the next line that is not indented.
      .map((item) => collapseSpaces(item.split(/\n(?=\S)/, 1)[0]))
  )

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
        // What was said of its heading because of the kind of release.
        levelProblems: NotesProblem[]
      }
    | undefined
  // What the lines seen so far say about the notes as a whole.
  const seen = {
    lastSectionIndex: -1,
    // The line of the heading of each section, by the place of the section in the rules.
    sectionLineNumbers: new Map<number, number>(),
    hasBreakingSection: false,
    hasTextBeforeSections: false,
    // The line that underlines the last heading written in that way.
    underlineIndex: -1,
  }
  const allowedHeadings = `The only headings the notes can have are ${headingList}`

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
    if (!(section?.isAllowed === true && section.itemCount === 0) || section.hasProblem) {
      return
    }

    // A section with nothing in it is to remove, whatever release it goes with.
    for (const levelProblem of section.levelProblems) {
      problems.splice(problems.indexOf(levelProblem), 1)
    }
    problems.push({
      lineNumber: section.lineNumber,
      line: section.line,
      message: 'This section has no item. Give it at least one ("- …"), or leave the section out.',
    })
  }

  /**
   * Record that a section does not go with the kind of release the notes are for.
   *
   * @param lineNumber - Where the heading of the section is in the notes.
   * @param line - The heading, as it is written.
   * @param message - What is wrong, and what the section needs.
   */
  const addLevelProblem = (lineNumber: number, line: string, message: string): void => {
    const problem = { lineNumber, line, message }
    problems.push(problem)
    section?.levelProblems.push(problem)
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
    const firstLineNumber = seen.sectionLineNumbers.get(sectionIndex)
    if (firstLineNumber !== undefined) {
      problems.push({
        lineNumber,
        line,
        message: `The notes already have this section, on line ${String(firstLineNumber)}: put all its items under one heading.`,
      })
    } else if (sectionIndex < seen.lastSectionIndex) {
      problems.push({
        lineNumber,
        line,
        message: `The sections go in this order: ${headingList}.`,
      })
    }
    seen.sectionLineNumbers.set(sectionIndex, firstLineNumber ?? lineNumber)
    seen.lastSectionIndex = Math.max(seen.lastSectionIndex, sectionIndex)
    if (title === rules.breakingSection) {
      seen.hasBreakingSection = true
      if (context.level === 'minor' || context.level === 'patch') {
        addLevelProblem(
          lineNumber,
          line,
          `${context.version} is not a new major version, so its notes cannot have this section. A change that breaks existing code needs a major version.`
        )
      }
    }
    if (title === rules.featureSection && context.level === 'patch') {
      addLevelProblem(
        lineNumber,
        line,
        `${context.version} is a patch version, so its notes cannot have this section. Something new for users needs a minor version.`
      )
    }
  }

  /**
   * Say what to do with a heading that is not one of the sections.
   *
   * @param closestSection - The section the heading was most likely meant for, when there is
   *   one.
   *
   * @returns What to write instead, or why that section does not go with the release either.
   */
  const describeClosestSection = (closestSection: string | undefined): string => {
    if (closestSection === undefined) {
      return ' Replace this one with the one its items belong under, or remove it if they already are under one.'
    }
    if (closestSection === rules.breakingSection) {
      // The section is there, under a heading to correct: it is not also reported as missing.
      seen.hasBreakingSection = true
      if (context.level === 'minor' || context.level === 'patch') {
        return ` It reads as "### ${closestSection}", which the notes of ${context.version} cannot have: a change that breaks existing code needs a major version.`
      }
    }
    return closestSection === rules.featureSection && context.level === 'patch'
      ? ` It reads as "### ${closestSection}", which the notes of ${context.version} cannot have: something new for users needs a minor version.`
      : ` Write it "### ${closestSection}".`
  }

  /**
   * Check a line that is, or was meant as, a heading, and start its section.
   *
   * @param lineNumber - Where the heading is in the notes (1 for the first line).
   * @param line - The heading, as it is written.
   * @param heading - What the line has of a heading: its indentation, its level marker and
   *   its title, or `undefined` when it has no space after its marker.
   * @param isUnderlined - Whether the line is a heading by the line under it, not by a marker.
   */
  const checkHeading = (
    lineNumber: number,
    line: string,
    heading: Record<string, string | undefined> | undefined,
    isUnderlined = false
  ): void => {
    const title = (heading?.title ?? '').replace(REGEX_HEADING_CLOSING, '').trim()
    const sectionIndex =
      heading?.indentation === '' && heading.marker === '###' ? rules.sections.indexOf(title) : -1
    // The section the heading was most likely meant for, when it only differs from its title
    // by its case, its marker or what it ends with.
    const writtenTitle = (heading === undefined ? line.replace(/^#+/, '') : title)
      .trim()
      .replace(REGEX_HEADING_ENDING, '')
      .toLowerCase()
    const closestSection =
      rules.sections.find((name) => name.toLowerCase() === writtenTitle) ??
      Object.entries(rules.sectionAliases ?? {}).find(
        ([alias]) => alias.toLowerCase() === writtenTitle
      )?.[1]
    // A version as a heading is the heading of the entry, which the release writes.
    const advice = REGEX_VERSION_TITLE.test(writtenTitle)
      ? ' Remove it: the release writes the heading of the entry, with its version, itself.'
      : describeClosestSection(closestSection)
    closeSection()
    // What follows a heading that is not allowed is still checked as the content of a
    // section, so that one heading to correct is not reported again for each line under it.
    section = {
      isAllowed: sectionIndex !== -1,
      lineNumber,
      line,
      itemCount: 0,
      hasProblem: false,
      levelProblems: [],
    }
    if (sectionIndex !== -1) {
      checkSectionHeading(lineNumber, line, sectionIndex)
      return
    }
    if (isUnderlined) {
      problems.push({
        lineNumber,
        line,
        message: `With the line under it, Markdown reads this line as a heading. A heading is written on one line, with "###" before its title. ${allowedHeadings}.${advice}`,
      })
    } else if (heading === undefined) {
      problems.push({
        lineNumber,
        line,
        message: `A heading needs a space after its "#" marks. ${allowedHeadings}.${advice}`,
      })
    } else if (heading.indentation === '') {
      problems.push({
        lineNumber,
        line,
        message: `${allowedHeadings}, written exactly so.${advice}`,
      })
    } else {
      problems.push({
        lineNumber,
        line,
        message: `Markdown reads this line as a heading, and a heading starts at the beginning of its line. ${allowedHeadings}.${advice}`,
      })
    }
  }

  /**
   * Say how many lines of text come before the first heading, after the first of them.
   *
   * @param lineNumber - Where the first of these lines is in the notes (1 for the first line).
   *
   * @returns The rest of the subject of the sentence that says they are not in a section, and
   *   its verb.
   */
  const describeLinesBeforeSections = (lineNumber: number): string => {
    const followingLines = lines.slice(lineNumber)
    const headingIndex = followingLines.findIndex(
      (line) => REGEX_HEADING.test(line) || REGEX_HEADING_WITHOUT_SPACE.test(line)
    )
    const count = followingLines
      .slice(0, headingIndex === -1 ? undefined : headingIndex)
      .filter((line) => !/^[\t ]*$/.test(line)).length
    if (count === 0) {
      return ' is'
    }
    return `, and the ${count === 1 ? 'line' : `${String(count)} lines`} of text after it, are`
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
          `The notes start with one of the headings ${headingList}. This line${describeLinesBeforeSections(lineNumber)} not in a section: put what is there under one, as list items ("- …").`
        )
      }
    } else if (REGEX_UNDERLINE.test(line)) {
      addFormProblem(
        lineNumber,
        line,
        'Markdown reads this line as a rule, or as making a heading of the line above it. ' +
          `Neither is used in the notes: remove it. The only headings are ${headingList}.`
      )
    } else if (/^-(?:\s|$)/.test(line)) {
      section.itemCount++
      const item = line.slice(1).trim()
      if (item === '') {
        addFormProblem(
          lineNumber,
          line,
          'This item is empty. Write what changed for the user, or remove it (with its ' +
            'heading, if the section has nothing else).'
        )
      } else if (REGEX_PLACEHOLDER.test(item.replaceAll(REGEX_EMPHASIS, '').trim())) {
        addFormProblem(
          lineNumber,
          line,
          'This item is a placeholder. Write what changed for the user, or remove it (with ' +
            'its heading, if the section has nothing else).'
        )
      } else if (
        exampleItems.some(
          (exampleItem) =>
            exampleItem.startsWith(collapseSpaces(line)) ||
            collapseSpaces(line).startsWith(exampleItem)
        )
      ) {
        addFormProblem(
          lineNumber,
          line,
          'This item is the one of the example, which only shows the form. Write what changed ' +
            'for the user, or remove it.'
        )
      }
    } else if (/^[\t ]/.test(line)) {
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

  for (const [index, line] of lines.entries()) {
    if (index === seen.underlineIndex) {
      continue
    }
    const lineNumber = index + 1
    const codeBlockLine = codeBlockLines[index]

    if (codeBlockLine === 'opening') {
      if (section === undefined || section.itemCount === 0 || !/^[\t ]/.test(line)) {
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
            'This code block is never closed: end it with a line that has nothing but the ' +
            'marks that open it, indented like this one.',
        })
      }
    } else if (codeBlockLine === 'escaped' && codeBlockLines.includes('closing', index)) {
      // In a block that is never closed, that is the one thing to correct.
      addFormProblem(
        lineNumber,
        line,
        'This line is in a code block, but indented less than the line that opens the block: ' +
          'Markdown ends the block here. Indent every line of the block at least as much as ' +
          'that line.'
      )
    }
    if (codeBlockLine !== 'outside' || /^[\t ]*$/.test(line)) {
      continue
    }

    const heading = REGEX_HEADING.exec(line)?.groups
    if (heading !== undefined || REGEX_HEADING_WITHOUT_SPACE.test(line)) {
      checkHeading(lineNumber, line, heading)
      continue
    }
    if (
      // A line of text only: not an item, the rest of one, or a rule.
      !/^(?:\s|-(?:\s|$))/.test(line) &&
      !REGEX_OTHER_LIST_MARKER.test(line) &&
      !REGEX_UNDERLINE.test(line) &&
      codeBlockLines[index + 1] === 'outside' &&
      REGEX_HEADING_UNDERLINE.test(lines.at(index + 1) ?? '')
    ) {
      seen.underlineIndex = index + 1
      checkHeading(lineNumber, line, { indentation: '', marker: '', title: line }, true)
      continue
    }

    // What is forbidden comes first: when a line has to go, that is the thing to know about
    // it. Most of it is looked for in the text, not in the code the text quotes.
    const text = line.replaceAll(REGEX_INLINE_CODE, '')
    for (const forbidden of forbiddenPatterns) {
      const found = forbidden.expression.exec(forbidden.isInCode ? line : text)?.[0]
      if (found !== undefined) {
        // With what was found: the line can be long, and is not quoted whole.
        problems.push({
          lineNumber,
          line,
          message: found === '' ? forbidden.reason : `${forbidden.reason} Here: "${found}".`,
        })
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
      message: `${context.version} is a new major version: its notes need a "### ${rules.breakingSection}" section saying what breaks. If nothing breaks, it is not a major version: release a minor or a patch one.`,
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
 * Read the titles of the sections the configuration gives.
 *
 * @param sections - The `sections` of the `notes` of the configuration.
 *
 * @returns The titles, all different.
 *
 * @throws If the value is not a list with at least one title, or if one of its entries is
 *   not a title, or is there twice. The error names the entry.
 */
const readSections = (sections: unknown): string[] => {
  if (!isConfigList(sections) || sections.length === 0) {
    throw createConfigError(
      '"notes.sections" must be the list of the titles of the sections, with at least one'
    )
  }
  const titles: string[] = []
  for (const [index, title] of sections.entries()) {
    const place = `entry ${String(index + 1)} of "notes.sections"`
    if (typeof title !== 'string') {
      throw createConfigError(`${place} must be text: the title of a section`)
    }
    if (title === '') {
      throw createConfigError(`${place} is empty`)
    }
    if (title.trim() !== title) {
      throw createConfigError(`${place} (${JSON.stringify(title)}) has spaces around it`)
    }
    if (title.startsWith('#') || title.endsWith('#')) {
      throw createConfigError(
        `${place} (${JSON.stringify(title)}) has the "#" marks of a heading: give the title only`
      )
    }
    if (titles.includes(title)) {
      throw createConfigError(`${JSON.stringify(title)} is in "notes.sections" twice`)
    }
    titles.push(title)
  }
  return titles
}

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
  (value.inCode === undefined || typeof value.inCode === 'boolean')

/**
 * Check that a value read from the configuration is a list.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is an array, of anything.
 */
const isConfigList = (value: unknown): value is unknown[] => Array.isArray(value)

/**
 * Read what the configuration forbids in the notes.
 *
 * @param forbidden - The `forbidden` of the `notes` of the configuration.
 *
 * @returns The patterns, each of which is a regular expression.
 *
 * @throws If the value is not a list, or if one of its patterns has a key that is not known,
 *   is not in the expected form or is not a regular expression. The error names the pattern.
 */
const readForbiddenPatterns = (forbidden: unknown): ForbiddenPattern[] => {
  if (!isConfigList(forbidden)) {
    throw createConfigError(
      '"notes.forbidden" must be a list of { "pattern", "reason", "flags"?, "inCode"? }'
    )
  }
  const forbiddenPatterns: ForbiddenPattern[] = []
  for (const [index, forbiddenPattern] of forbidden.entries()) {
    const place = `pattern ${String(index + 1)} of "notes.forbidden"`
    const unknownKey = isConfigObject(forbiddenPattern)
      ? Object.keys(forbiddenPattern).find((key) => !FORBIDDEN_KEYS.includes(key))
      : undefined
    if (unknownKey !== undefined) {
      throw createConfigError(
        `${place} has a key that is not known, "${unknownKey}": the keys are ` +
          FORBIDDEN_KEYS.map((key) => `"${key}"`).join(', ')
      )
    }
    if (!isForbiddenPattern(forbiddenPattern)) {
      throw createConfigError(
        `${place} must be { "pattern", "reason", "flags"?, "inCode"? }, where the pattern and ` +
          'the reason are text that is not empty, the flags are text and inCode is true or false'
      )
    }
    const expression = noThrow(() => compileForbiddenPattern(forbiddenPattern))
    if (isNormalizedError(expression)) {
      throw createConfigError(
        `${place} is not a regular expression: ${JSON.stringify(forbiddenPattern.pattern)}` +
          `${forbiddenPattern.flags === undefined ? '' : ` with the flags ${JSON.stringify(forbiddenPattern.flags)}`} ` +
          `(${expression.message})`
      )
    }
    forbiddenPatterns.push(forbiddenPattern)
  }
  return forbiddenPatterns
}

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
  if (typeof value !== 'string') {
    throw createConfigError(`"notes.${name}" must be text: the title of one of the sections`)
  }
  if (!sections.includes(value)) {
    throw createConfigError(
      `"notes.${name}" is ${JSON.stringify(value)}, which is not one of the titles of ` +
        `"notes.sections" (${sections.map((section) => `"${section}"`).join(', ')})`
    )
  }
  return value
}

/**
 * Read the other titles the configuration gives to its sections.
 *
 * @param aliases - The `sectionAliases` of the `notes` of the configuration.
 * @param sections - The titles of the sections.
 *
 * @returns The titles, each with the one of its section, or `undefined` when the
 *   configuration gives none.
 *
 * @throws If the value is not an object, or if one of its titles is not given a section.
 */
const readSectionAliases = (
  aliases: unknown,
  sections: string[]
): Record<string, string> | undefined => {
  if (aliases === undefined) {
    return undefined
  }
  if (!isConfigObject(aliases)) {
    throw createConfigError(
      '"notes.sectionAliases" must be an object: other titles the sections are known by, ' +
        'each with the title of its section'
    )
  }
  const sectionAliases: Record<string, string> = {}
  for (const [alias, section] of Object.entries(aliases)) {
    if (typeof section !== 'string' || !sections.includes(section)) {
      throw createConfigError(
        `"notes.sectionAliases" gives ${JSON.stringify(alias)} the section ${JSON.stringify(section)}, ` +
          `which is not one of the titles of "notes.sections" (${sections.map((title) => `"${title}"`).join(', ')})`
      )
    }
    sectionAliases[alias] = section
  }
  return sectionAliases
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
  return value.replaceAll(/\r\n?/g, '\n')
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
  if (example === undefined) {
    return
  }
  const hazards = findNotesHazards(example.trimEnd())
  const hazard = hazards.codeBlock ?? hazards.content
  if (hazard !== undefined) {
    throw createConfigError(
      `"notes.${name}" could not be used as release notes: ${hazard.replace('🚨 the release notes', 'it would')}`
    )
  }
  const problem = findNotesProblems(
    example.trimEnd(),
    // Without the examples: their items are refused in notes, and are what is checked here.
    { ...rules, example: '', majorExample: undefined },
    { version: 'It', level }
  ).at(0)
  if (problem !== undefined) {
    throw createConfigError(
      `"notes.${name}" does not follow the rules of the same file as the notes of a ${level} release, which it is shown for` +
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
  if (content.trim() === '') {
    throw createConfigError(
      'the file is empty: give it the rules of the notes, under "notes", or delete it to have none'
    )
  }
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
  const sections = readSections(notes.sections)
  const example = readExampleProperty(notes, 'example')
  if (example === undefined) {
    throw createConfigError(
      '"notes.example" is missing: release notes that follow the rules, shown when notes do not'
    )
  }
  const majorExample = readExampleProperty(notes, 'majorExample')
  const breakingSection = readSectionProperty(notes, 'breakingSection', sections)
  if (majorExample === undefined && breakingSection !== undefined) {
    throw createConfigError(
      '"notes.majorExample" is missing: with a "breakingSection", the notes of a major release ' +
        'need an example of their own, which has that section'
    )
  }
  const rules = {
    sections,
    breakingSection,
    featureSection: readSectionProperty(notes, 'featureSection', sections),
    forbidden: readForbiddenPatterns(notes.forbidden === undefined ? [] : notes.forbidden),
    example,
    majorExample,
    sectionAliases: readSectionAliases(notes.sectionAliases, sections),
  }
  // The example is shown for the releases that are not major ones, so it is checked as the
  // notes of a patch release, which every one of them accepts.
  assertExampleFollowsRules('example', example, rules, 'patch')
  assertExampleFollowsRules('majorExample', majorExample, rules, 'major')
  return rules
}

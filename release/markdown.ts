/**
 * The last word on what release notes would do to a changelog: how Markdown renders it, by
 * the rules GitHub follows. The other checks read the notes line by line and with a parser
 * that is close to those rules; where either reads something differently, notes could pass
 * them and still take in or change the older entries. Here the changelog is rendered with
 * `micromark`, which follows the rules to the letter, before and after the entry is added.
 *
 * `micromark` is an ES module, which the tests of this repository cannot load in their own
 * process: it is run in one of its own, like `git`, `npm` and `prettier`.
 */
import { readChangelogTitle } from './changelog'
import { runCommand } from './workspace'

import type { Workspace } from './workspace'

/**
 * Renders the Markdown texts it is given as a JSON array on its standard input, with their
 * HTML copied as it is, as GitHub renders it. The first one, the notes, is also rendered with
 * its HTML shown as text. The first two, the notes as they are written and as they are
 * formatted, are read for the link definitions Markdown finds in them, and for the headings
 * it renders like the heading of a changelog entry: a linked version, at one of the first two
 * levels, however it is spelled.
 */
const RENDER_SCRIPT = [
  "import { micromark, parse, postprocess, preprocess } from 'micromark'",
  "let input = ''",
  'for await (const chunk of process.stdin) input += chunk',
  'const texts = JSON.parse(input)',
  // Only the notes are rendered both ways: the other texts can be large.
  'const render = (text, index) => [',
  '  micromark(text, { allowDangerousHtml: true }),',
  "  index === 0 ? micromark(text) : '',",
  ']',
  'const readEvents = (text) =>',
  '  postprocess(parse().document().write(preprocess()(text, undefined, true)))',
  'const readDefinitionLines = (text) =>',
  '  readEvents(text)',
  "    .filter(([kind, token]) => kind === 'enter' && token.type === 'definition')",
  '    .map(([, token]) => token.start.line)',
  'const definitionLines = texts.slice(0, 2).map(readDefinitionLines)',
  // The headings Markdown finds and those it renders are the same ones, in the same order.
  'const readHeadingLines = (text) =>',
  '  readEvents(text)',
  '    .filter(',
  '      ([kind, token]) =>',
  "        kind === 'enter' && (token.type === 'atxHeading' || token.type === 'setextHeading')",
  '    )',
  '    .map(([, token]) => token.start.line)',
  'const readEntryHeadingLines = (text) => {',
  '  const lines = readHeadingLines(text)',
  String.raw`  return [...micromark(text).matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].flatMap(`,
  '    ([, level, html], index) =>',
  "      Number(level) <= 2 && html.includes('<a ') &&",
  String.raw`      /^[\s\p{Z}\p{Cf}]*v?\d+\.\d+\.\d/u.test(html.replace(/<[^>]*>/g, ''))`,
  '        ? [lines[index] ?? 1]',
  '        : []',
  '  )',
  '}',
  'const headingLines = texts.slice(0, 2).map(readEntryHeadingLines)',
  'process.stdout.write(',
  '  JSON.stringify({ renderings: texts.map(render), definitionLines, headingLines })',
  ')',
].join('\n')

/** A Markdown text, rendered both ways. */
type Rendering = {
  /** The HTML of the text, with the HTML it holds copied as it is. */
  html: string
  /** The HTML of the text, with the HTML it holds shown as text: only for the first text. */
  safeHtml: string
}

/** What the script found. */
type MarkdownReading = {
  /** Each text rendered, in the order they were given. */
  renderings: Rendering[]
  /**
   * For each of the first two texts, the lines where a link definition starts (1 for the
   * first line).
   */
  definitionLines: number[][]
  /**
   * For each of the first two texts, the lines where a heading starts that renders like the
   * heading of a changelog entry.
   */
  headingLines: number[][]
}

/**
 * Check that a value is a list of line numbers for each text that was read.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is a list of lists of numbers.
 */
const isLineNumberLists = (value: unknown): value is number[][] =>
  Array.isArray(value) &&
  value.every((lines) => Array.isArray(lines) && lines.every((line) => typeof line === 'number'))

/**
 * Check that a value is what the script printed for one text.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is a pair of strings.
 */
const isRenderedPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((element) => typeof element === 'string')

/**
 * Check that a value is what the script printed.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has the renderings, as pairs, and the lines of the definitions
 *   and of the headings.
 */
const isScriptOutput = (
  value: unknown
): value is {
  renderings: [string, string][]
  definitionLines: number[][]
  headingLines: number[][]
} =>
  typeof value === 'object' &&
  value !== null &&
  'renderings' in value &&
  Array.isArray(value.renderings) &&
  value.renderings.every((rendering) => isRenderedPair(rendering)) &&
  'definitionLines' in value &&
  isLineNumberLists(value.definitionLines) &&
  'headingLines' in value &&
  isLineNumberLists(value.headingLines)

/**
 * Read Markdown texts as Markdown does.
 *
 * @param workspace - Where to run the reader: the repository, which has it installed.
 * @param texts - What to read: the release notes first, as written then as formatted.
 *
 * @returns Each text rendered, in the same order, and where the first two define links or
 *   have a heading like the one of an entry.
 *
 * @throws If the reader cannot be run.
 */
const readMarkdown = (workspace: Workspace, texts: string[]): MarkdownReading => {
  const result = runCommand(
    workspace,
    'node',
    ['--input-type=module', '--eval', RENDER_SCRIPT],
    false,
    JSON.stringify(texts)
  )
  const output: unknown = result.isSuccess ? JSON.parse(result.output) : undefined
  if (!isScriptOutput(output)) {
    throw new Error(
      `🚨 the release could not render Markdown to check its notes: ${result.failure.replace(RENDER_SCRIPT, '<a script that renders Markdown>')}\n` +
        '   It does so with micromark, a development dependency: install the dependencies ' +
        '(`npm ci`), or add it (`npm install --save-dev micromark`), then run this again.'
    )
  }
  return {
    renderings: output.renderings.map(([html, safeHtml]) => ({ html, safeHtml })),
    definitionLines: output.definitionLines,
    headingLines: output.headingLines,
  }
}

/**
 * Check that a changelog renders its older entries as before, now that it has one more.
 *
 * @param previousHtml - The changelog before the release, rendered.
 * @param titleHtml - What that changelog has before its entries, rendered.
 * @param html - The changelog with the entry of the release, rendered.
 *
 * @returns `true` if the changelog still starts with what its title rendered, and ends with
 *   what its entries rendered.
 */
const hasSameOlderEntries = (previousHtml: string, titleHtml: string, html: string): boolean => {
  // Without the end of the last line, which a text that ends without one does not render.
  const title = titleHtml.trimEnd()
  if (previousHtml.startsWith(title)) {
    return (
      html.startsWith(title) && html.trimEnd().endsWith(previousHtml.slice(title.length).trim())
    )
  }
  // A title that does not render the same by itself (it defines links the entries use): the
  // older entries are then what the changelog has after what it shares with the new one,
  // which leaves out the first characters of their first heading.
  let sharedLength = 0
  while (
    sharedLength < previousHtml.length &&
    previousHtml.charAt(sharedLength) === html.charAt(sharedLength)
  ) {
    sharedLength++
  }
  return html.trimEnd().endsWith(previousHtml.slice(sharedLength).trimEnd())
}

/**
 * Name lines of a text, for a message.
 *
 * @param text - The text the lines are in.
 * @param lineNumbers - Which lines to name (1 for the first).
 *
 * @returns Their numbers and what they say.
 */
const describeLines = (text: string, lineNumbers: number[]): string => {
  const lines = text.split('\n')
  return lineNumbers
    .map((lineNumber) => `line ${String(lineNumber)}: ${lines[lineNumber - 1]}`)
    .join('; ')
}

/**
 * Find what release notes would do to a changelog when Markdown renders it, that the other
 * checks did not find.
 *
 * @param workspace - The repository being released.
 * @param notes - The release notes (see `cleanReleaseNotes`).
 * @param formattedNotes - The notes as prettier formats them in the changelog, or an empty
 *   string when that could not be read.
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 * @param changelogs - Its content with the entry of the release: as it is written, and as
 *   prettier formats it.
 *
 * @returns What is wrong and what to do about it, each `undefined` when nothing is: with the
 *   notes themselves (HTML, a link definition, a heading like the one of an entry), and with
 *   what they do to the rest of the page.
 *
 * @throws If the changelog cannot be rendered.
 */
export const findRenderingHazards = (
  workspace: Workspace,
  notes: string,
  formattedNotes: string,
  previousChangelog: string,
  changelogs: string[]
): { notes: string | undefined; page: string | undefined } => {
  const { renderings, definitionLines, headingLines } = readMarkdown(workspace, [
    notes,
    formattedNotes,
    previousChangelog,
    readChangelogTitle(previousChangelog),
    ...changelogs,
  ])
  const [renderedNotes, , renderedPrevious, renderedTitle, ...renderedChangelogs] = renderings
  const [notesDefinitionLines, formattedDefinitionLines] = definitionLines
  const [notesHeadingLines, formattedHeadingLines] = headingLines
  let notesHazard: string | undefined
  if (renderedNotes.html !== renderedNotes.safeHtml) {
    notesHazard =
      '🚨 the release notes have something Markdown reads as HTML, in a way that only ' +
      'rendering them shows: Markdown copies it as it is, and a tag or a comment that is ' +
      'left open would take in the rest of the changelog. Look for a "<" outside backticks, ' +
      'or in a code block that ends sooner than it seems to (a line that closes it, written ' +
      'another way), and put the code in backticks or remove it.'
  } else if (notesDefinitionLines.length > 0) {
    notesHazard =
      `🚨 the release notes define a link for the whole changelog (${describeLines(notes, notesDefinitionLines)}): ` +
      'what starts on that line is read as a definition, "[label]: url", in a way that only ' +
      'reading the notes as Markdown shows (its parts can be on several lines). It changes ' +
      'every "[label]" of the changelog. Write the link where it is used: [text](url).'
  } else if (formattedDefinitionLines.length > 0) {
    notesHazard =
      `🚨 once formatted, the release notes define a link for the whole changelog (${describeLines(formattedNotes, formattedDefinitionLines)}, as prettier writes it): ` +
      'the notes have it in parts, on several lines or after a table, which GitHub reads as ' +
      'a definition, "[label]: url". It changes every "[label]" of the changelog. Find the ' +
      'lines of the notes that have those words, and write the link where it is used: ' +
      '[text](url).'
  } else if (notesHeadingLines.length > 0) {
    notesHazard =
      `🚨 the release notes have a heading that renders like the heading of a changelog entry (${describeLines(notes, notesHeadingLines)}): ` +
      'a linked version, in a spelling that only rendering the notes shows (an entity, an ' +
      'escape, a character that does not show, a line break). Remove it: the release writes ' +
      'the heading of the entry itself.'
  } else if (formattedHeadingLines.length > 0) {
    notesHazard =
      `🚨 once formatted, the release notes have a heading that renders like the heading of a changelog entry (${describeLines(formattedNotes, formattedHeadingLines)}, as prettier writes it): ` +
      'the notes have a linked version and a line under it that prettier writes as a ' +
      'heading (after a table or a list item that is empty). Remove those lines: the release ' +
      'writes the heading of the entry itself.'
  }
  return {
    notes: notesHazard,
    page: renderedChangelogs.some(
      (rendered) => !hasSameOlderEntries(renderedPrevious.html, renderedTitle.html, rendered.html)
    )
      ? '🚨 with these release notes, the older entries of CHANGELOG.md, or what comes before ' +
        'its entries, would not render as they do now: the notes leave something open that ' +
        'takes them in, or change what they mean (a code block that is not closed, a list or ' +
        'a quote that goes on, a link definition "[label]: url", however it is written). ' +
        'Check that every code block of the notes is closed and indented under its item, ' +
        'that the notes end with a complete item, and that no line defines a link.'
      : undefined,
  }
}

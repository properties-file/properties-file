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
 * Renders the Markdown texts it is given as a JSON array on its standard input, each twice:
 * with its HTML copied as it is, as GitHub renders it, and with its HTML shown as text.
 */
const RENDER_SCRIPT = [
  "import { micromark } from 'micromark'",
  "let input = ''",
  'for await (const chunk of process.stdin) input += chunk',
  'const render = (text) => [micromark(text, { allowDangerousHtml: true }), micromark(text)]',
  'process.stdout.write(JSON.stringify(JSON.parse(input).map(render)))',
].join('\n')

/** A Markdown text, rendered both ways. */
type Rendering = {
  /** The HTML of the text, with the HTML it holds copied as it is. */
  html: string
  /** The HTML of the text, with the HTML it holds shown as text. */
  safeHtml: string
}

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
 * Render Markdown texts.
 *
 * @param workspace - Where to run the renderer: the repository, which has it installed.
 * @param texts - What to render.
 *
 * @returns Each text rendered, in the same order.
 *
 * @throws If the renderer cannot be run.
 */
const renderMarkdown = (workspace: Workspace, texts: string[]): Rendering[] => {
  const result = runCommand(
    workspace,
    'node',
    ['--input-type=module', '--eval', RENDER_SCRIPT],
    false,
    JSON.stringify(texts)
  )
  const renderings: unknown = result.isSuccess ? JSON.parse(result.output) : undefined
  if (!Array.isArray(renderings) || renderings.some((rendering) => !isRenderedPair(rendering))) {
    throw new Error(
      `🚨 the release could not render Markdown to check its notes: ${result.failure.replace(RENDER_SCRIPT, '<a script that renders Markdown>')}\n` +
        '   It does so with micromark, a development dependency: install the dependencies ' +
        '(`npm ci`), or add it (`npm install --save-dev micromark`), then run this again.'
    )
  }
  return renderings
    .filter((rendering) => isRenderedPair(rendering))
    .map(([html, safeHtml]) => ({ html, safeHtml }))
}

/**
 * Check that a changelog renders its older entries as before, now that it has one more.
 *
 * @param previousHtml - The changelog before the release, rendered.
 * @param titleHtml - What that changelog has before its entries, rendered.
 * @param html - The changelog with the entry of the release, rendered.
 *
 * @returns `true` if everything the changelog rendered after its title, its entries, is still
 *   what it renders last.
 */
const hasSameOlderEntries = (previousHtml: string, titleHtml: string, html: string): boolean => {
  // Without the end of the last line, which a text that ends without one does not render.
  const title = titleHtml.trimEnd()
  if (previousHtml.startsWith(title)) {
    return html.trimEnd().endsWith(previousHtml.slice(title.length).trim())
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
 * Find what release notes would do to a changelog when Markdown renders it, that the other
 * checks did not find.
 *
 * @param workspace - The repository being released.
 * @param notes - The release notes (see `cleanReleaseNotes`).
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 * @param changelogs - Its content with the entry of the release: as it is written, and as
 *   prettier formats it.
 *
 * @returns What is wrong and what to do about it, or `undefined` when nothing is.
 *
 * @throws If the changelog cannot be rendered.
 */
export const findRenderingHazard = (
  workspace: Workspace,
  notes: string,
  previousChangelog: string,
  changelogs: string[]
): string | undefined => {
  const [renderedNotes, renderedPrevious, renderedTitle, ...renderedChangelogs] = renderMarkdown(
    workspace,
    [notes, previousChangelog, readChangelogTitle(previousChangelog), ...changelogs]
  )
  if (renderedNotes.html !== renderedNotes.safeHtml) {
    return (
      '🚨 the release notes have something Markdown reads as HTML, in a way that only ' +
      'rendering them shows: Markdown copies it as it is, and a tag or a comment that is ' +
      'left open would take in the rest of the changelog. Look for a "<" outside backticks, ' +
      'or in a code block that ends sooner than it seems to (a line that closes it, written ' +
      'another way), and put the code in backticks or remove it.'
    )
  }
  if (
    renderedChangelogs.some(
      (rendered) => !hasSameOlderEntries(renderedPrevious.html, renderedTitle.html, rendered.html)
    )
  ) {
    return (
      '🚨 with these release notes, the older entries of CHANGELOG.md would not render as ' +
      'they do now: the notes leave something open that takes them in, or change what they ' +
      'mean (a code block that is not closed, a list or a quote that goes on, a link ' +
      'definition "[label]: url", however it is written). Check that every code block of ' +
      'the notes is closed and indented under its item, that the notes end with a complete ' +
      'item, and that no line defines a link.'
    )
  }
  return undefined
}

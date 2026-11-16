/**
 * The entry point of `npm run release` (see ./release.ts and ./brief.ts for what it does, and
 * `USAGE` in ./release.ts for how it is called).
 */
import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { brief } from './brief'
import { explainDryRun, parseReleaseArguments, release } from './release'

/**
 * How long to wait for the first byte of the release notes. A heredoc or a redirected file is
 * there at once; this only matters when nothing was redirected and the caller left the
 * standard input open without ever writing to it, as some tools that run commands do.
 */
const STANDARD_INPUT_WAIT = 3000

/**
 * Read what the command was given on its standard input.
 *
 * @returns The text, or an empty string when the standard input is a terminal or stays silent.
 */
const readStandardInput = async (): Promise<string> => {
  const input = process.stdin
  if (input.isTTY) {
    return ''
  }
  return new Promise((resolve) => {
    let text = ''
    const timer = setTimeout(() => {
      input.destroy()
      resolve('')
    }, STANDARD_INPUT_WAIT)
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      clearTimeout(timer)
      text += chunk
    })
    input.on('end', () => {
      clearTimeout(timer)
      resolve(text)
    })
    input.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
  })
}

/**
 * Report a line of the command.
 *
 * @param message - The line.
 */
const log = (message: string): void => {
  console.log(message)
}

const commandArguments = process.argv.slice(2)

const outcome = await noThrow(async () => {
  const releaseArguments = parseReleaseArguments(commandArguments, process.env)
  const common = { directoryPath: process.cwd(), environment: process.env, log }
  if (releaseArguments.command === 'brief') {
    brief(common)
    return
  }
  const explanation = explainDryRun(commandArguments, process.env)
  if (explanation !== undefined) {
    log(explanation)
  }
  release({
    ...common,
    request: releaseArguments.request,
    isDryRun: releaseArguments.isDryRun,
    notes: await readStandardInput(),
    date: new Date(),
    shouldStreamOutput: true,
  })
})

if (isNormalizedError(outcome)) {
  console.error(outcome.message)
  process.exitCode = 1
}

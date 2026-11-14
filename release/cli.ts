/**
 * The entry point of `npm run release -- <major | minor | patch | x.y.z> [--confirm]`
 * (see ./release.ts for what a release does, and why it is a dry run without `--confirm`).
 */
import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { explainDryRun, parseReleaseArguments, release } from './release'

const commandArguments = process.argv.slice(2)

const outcome = noThrow(() => {
  const releaseArguments = parseReleaseArguments(commandArguments, process.env)
  const explanation = explainDryRun(commandArguments, process.env)
  if (explanation !== undefined) {
    console.log(explanation)
  }
  return release({
    ...releaseArguments,
    directoryPath: process.cwd(),
    environment: process.env,
    date: new Date(),
    shouldStreamOutput: true,
    log: (message) => {
      console.log(message)
    },
  })
})

if (isNormalizedError(outcome)) {
  console.error(outcome.message)
  process.exitCode = 1
}

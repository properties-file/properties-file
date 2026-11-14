/**
 * The entry point of `npm run release -- <major | minor | patch | x.y.z> [--dry-run]`
 * (see ./release.ts for what a release does).
 */
import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { parseReleaseArguments, release } from './release'

const outcome = noThrow(() =>
  release({
    ...parseReleaseArguments(process.argv.slice(2)),
    directoryPath: process.cwd(),
    date: new Date(),
    shouldStreamOutput: true,
    log: (message) => {
      console.log(message)
    },
  })
)

if (isNormalizedError(outcome)) {
  console.error(outcome.message)
  process.exitCode = 1
}

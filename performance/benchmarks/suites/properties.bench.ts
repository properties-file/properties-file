import { Bench } from 'tinybench'

import { getProperties, Properties } from '../../../src'
import { payloads } from '../payloads'

/**
 * Benchmark the `Properties` constructor and `getProperties` across all payload types.
 *
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runPropertiesBenchmarks = async (): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })

  for (const payload of payloads) {
    const content = payload.generate()

    bench.add(`Properties constructor (${payload.name})`, () => {
      new Properties(content)
    })

    bench.add(`getProperties (${payload.name})`, () => {
      getProperties(content)
    })
  }

  await bench.run()
  return bench
}

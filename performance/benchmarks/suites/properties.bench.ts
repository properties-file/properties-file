import { Bench } from 'tinybench'

import { payloads } from '../payloads'

/** The module shape required by the Properties benchmark suite. */
export type PropertiesModule = {
  /** Converts `.properties` content to a key-value pair object. */
  getProperties: (content: string | Buffer) => Record<string, string>
  /** The `Properties` class constructor. */
  Properties: new (content: string) => unknown
}

/**
 * Benchmark the `Properties` constructor and `getProperties` across all payload types.
 *
 * Receives its dependencies via injection so that the same suite can be run against
 * different compiled builds (current vs baseline) without import-time coupling.
 *
 * @param modules - The properties module to benchmark (must provide `getProperties` and `Properties`).
 *
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runPropertiesBenchmarks = async (modules: PropertiesModule): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })

  for (const payload of payloads) {
    const content = payload.generate()

    bench.add(`Properties constructor (${payload.name})`, () => {
      new modules.Properties(content)
    })

    bench.add(`getProperties (${payload.name})`, () => {
      modules.getProperties(content)
    })
  }

  await bench.run()
  return bench
}

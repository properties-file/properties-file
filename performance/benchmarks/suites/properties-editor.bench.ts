import { Bench } from 'tinybench'

import { generateMixed } from '../payloads'

/** The module shape required by the PropertiesEditor benchmark suite. */
export type PropertiesEditorModule = {
  /** The `PropertiesEditor` class constructor. */
  PropertiesEditor: new (content: string) => {
    insert: (key: string, value: string) => void
    update: (key: string, options: { newValue: string }) => void
    upsert: (key: string, value: string) => void
    delete: (key: string) => void
  }
}

/**
 * Benchmark `PropertiesEditor` operations (insert, update, upsert, delete)
 * against a mixed/realistic payload.
 *
 * Receives its dependencies via injection so that the same suite can be run against
 * different compiled builds (current vs baseline) without import-time coupling.
 *
 * @param modules - The editor module to benchmark (must provide `PropertiesEditor`).
 *
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runEditorBenchmarks = async (modules: PropertiesEditorModule): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })
  const content = generateMixed()

  bench.add('PropertiesEditor insert', () => {
    const editor = new modules.PropertiesEditor(content)
    editor.insert('newKey', 'newValue')
  })

  bench.add('PropertiesEditor update', () => {
    const editor = new modules.PropertiesEditor(content)
    editor.update('hello', { newValue: 'updated' })
  })

  bench.add('PropertiesEditor upsert', () => {
    const editor = new modules.PropertiesEditor(content)
    editor.upsert('hello', 'upserted')
  })

  bench.add('PropertiesEditor delete', () => {
    const editor = new modules.PropertiesEditor(content)
    editor.delete('hello')
  })

  await bench.run()
  return bench
}

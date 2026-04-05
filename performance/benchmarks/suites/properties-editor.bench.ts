import { Bench } from 'tinybench'

import { PropertiesEditor } from '../../../src/editor'
import { generateMixed } from '../payloads'

/**
 * Benchmark `PropertiesEditor` operations (insert, update, upsert, delete)
 * against a mixed/realistic payload.
 *
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runEditorBenchmarks = async (): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })
  const content = generateMixed()

  bench.add('PropertiesEditor insert', () => {
    const editor = new PropertiesEditor(content)
    editor.insert('newKey', 'newValue')
  })

  bench.add('PropertiesEditor update', () => {
    const editor = new PropertiesEditor(content)
    editor.update('hello', { newValue: 'updated' })
  })

  bench.add('PropertiesEditor upsert', () => {
    const editor = new PropertiesEditor(content)
    editor.upsert('hello', 'upserted')
  })

  bench.add('PropertiesEditor delete', () => {
    const editor = new PropertiesEditor(content)
    editor.delete('hello')
  })

  await bench.run()
  return bench
}

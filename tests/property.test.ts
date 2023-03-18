import { Property } from '../src'

describe('The property key escaping', () => {
  it.each([
    ['foo1', 'foo1'],
    ['foo2:', 'foo2\\:'],
    ['foo3=', 'foo3\\='],
    ['foo4\t', 'foo4\\t'],
    ['foo5 ', 'foo5\\ '],
    [' foo6', '\\ foo6'],
    ['#foo7', '\\#foo7'],
    ['!foo8#', '\\!foo8\\#'],
    ['fo  o9', 'fo\\ \\ o9'],
    ['foo10\n', 'foo10\\n'],
    ['f\r\f\n\too11', 'f\\r\\f\\n\\too11'],
    ['\\foo12\\', '\\\\foo12\\\\'],
    ['\0\u0001', '\\u0000\\u0001'],
    ['\u3053\u3093\u306B\u3061\u306F', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
    ['こんにちは', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = Property.escapeKey(key)
    expect(result).toEqual(expected)
  })
})

describe('The property value escaping', () => {
  it.each([
    ['foo1', 'foo1'],
    ['foo2:', 'foo2\\:'],
    ['foo3=', 'foo3\\='],
    ['foo4\t', 'foo4\\t'],
    ['foo5 ', 'foo5 '],
    [' foo6', '\\ foo6'],
    ['#foo7', '\\#foo7'],
    ['!foo8#', '\\!foo8\\#'],
    ['fo  o9', 'fo  o9'],
    ['foo10\n', 'foo10\\n'],
    ['f\r\f\n\too11', 'f\\r\\f\\n\\too11'],
    ['\\foo12\\', '\\\\foo12\\\\'],
    ['\0\u0001', '\\u0000\\u0001'],
    ['\u3053\u3093\u306B\u3061\u306F', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
    ['こんにちは', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
  ])('should escape value "%s" as "%s"', (key: string, expected: string) => {
    const result = Property.escapeValue(key)
    expect(result).toEqual(expected)
  })
})

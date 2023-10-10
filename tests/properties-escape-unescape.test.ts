import { escapeKey, escapeValue } from '../src/escape/index'

describe('The property unicode key escaping', () => {
  it.each([
    ['こんにちは1', 'こんにちは1'],
    ['こんにちは2:', 'こんにちは2\\:'],
    ['こんにちは3=', 'こんにちは3\\='],
    ['こんにちは4\t', 'こんにちは4\\t'],
    ['こんにちは5 ', 'こんにちは5\\ '],
    [' こんにちは6', '\\ こんにちは6'],
    ['#こんにちは7', '\\#こんにちは7'],
    ['!こんにちは8#', '\\!こんにちは8\\#'],
    ['こん  にちは9', 'こん\\ \\ にちは9'],
    ['こんにちは10\n', 'こんにちは10\\n'],
    ['こ\r\f\n\tんにちは11', 'こ\\r\\f\\n\\tんにちは11'],
    ['\\こんにちは12\\', '\\\\こんにちは12\\\\'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeKey(key)
    expect(result).toEqual(expected)
  })
})

describe('The property ISO-8859-1 compatible encoding key escaping', () => {
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
    [' fo  o10 ', '\\ fo\\ \\ o10\\ '],
    ['foo11\n', 'foo11\\n'],
    ['f\r\f\n\too12', 'f\\r\\f\\n\\too12'],
    ['\\foo13\\', '\\\\foo13\\\\'],
    ['\0\u0001', '\\u0000\\u0001'],
    ['\u3053\u3093\u306B\u3061\u306F', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
    ['こんにちは', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeKey(key, true)
    expect(result).toEqual(expected)
  })
})

describe('The property unicode value escaping', () => {
  it.each([
    ['こんにちは1', 'こんにちは1'],
    ['こんにちは2:', 'こんにちは2\\:'],
    ['こんにちは3=', 'こんにちは3\\='],
    ['こんにちは4\t', 'こんにちは4\\t'],
    ['こんにちは5 ', 'こんにちは5 '],
    ['  こんにちは6', '\\  こんにちは6'],
    ['#こんにちは7', '\\#こんにちは7'],
    ['!こんにちは8#', '\\!こんにちは8\\#'],
    ['こん  にちは9', 'こん  にちは9'],
    ['こんにちは10\n', 'こんにちは10\\n'],
    ['こ\r\f\n\tんにちは11', 'こ\\r\\f\\n\\tんにちは11'],
    ['\\こんにちは12\\', '\\\\こんにちは12\\\\'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeValue(key)
    expect(result).toEqual(expected)
  })
})

describe('The property ISO-8859-1 compatible encoding value escaping', () => {
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
    ['  fo  o10 ', '\\  fo  o10 '],
    ['foo11\n', 'foo11\\n'],
    ['f\r\f\n\too12', 'f\\r\\f\\n\\too12'],
    ['\\foo13\\', '\\\\foo13\\\\'],
    ['\0\u0001', '\\u0000\\u0001'],
    ['\u3053\u3093\u306B\u3061\u306F', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
    ['こんにちは', '\\u3053\\u3093\\u306b\\u3061\\u306f'],
  ])('should escape value "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeValue(key, true)
    expect(result).toEqual(expected)
  })
})

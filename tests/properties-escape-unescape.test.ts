import { escapeKey, escapeValue } from '../src/escape/index'

describe('The property unicode key escaping', () => {
  it.each([
    ['こんにちは1', 'こんにちは1'],
    ['こんにちは2:', String.raw`こんにちは2\:`],
    ['こんにちは3=', String.raw`こんにちは3\=`],
    ['こんにちは4\t', String.raw`こんにちは4\t`],
    ['こんにちは5 ', String.raw`こんにちは5\ `],
    [' こんにちは6', String.raw`\ こんにちは6`],
    ['#こんにちは7', String.raw`\#こんにちは7`],
    ['!こんにちは8#', String.raw`\!こんにちは8\#`],
    ['こん  にちは9', String.raw`こん\ \ にちは9`],
    ['こんにちは10\n', String.raw`こんにちは10\n`],
    ['こ\r\f\n\tんにちは11', String.raw`こ\r\f\n\tんにちは11`],
    ['\\こんにちは12\\', '\\\\こんにちは12\\\\'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeKey(key)
    expect(result).toEqual(expected)
  })
})

describe('The property ISO-8859-1 compatible encoding key escaping', () => {
  it.each([
    ['foo1', 'foo1'],
    ['foo2:', String.raw`foo2\:`],
    ['foo3=', String.raw`foo3\=`],
    ['foo4\t', String.raw`foo4\t`],
    ['foo5 ', String.raw`foo5\ `],
    [' foo6', String.raw`\ foo6`],
    ['#foo7', String.raw`\#foo7`],
    ['!foo8#', String.raw`\!foo8\#`],
    ['fo  o9', String.raw`fo\ \ o9`],
    [' fo  o10 ', String.raw`\ fo\ \ o10\ `],
    ['foo11\n', String.raw`foo11\n`],
    ['f\r\f\n\too12', String.raw`f\r\f\n\too12`],
    ['\\foo13\\', '\\\\foo13\\\\'],
    ['\0\u0001', String.raw`\u0000\u0001`],
    ['\u3053\u3093\u306B\u3061\u306F', String.raw`\u3053\u3093\u306b\u3061\u306f`],
    ['こんにちは', String.raw`\u3053\u3093\u306b\u3061\u306f`],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeKey(key, true)
    expect(result).toEqual(expected)
  })
})

describe('The property unicode value escaping', () => {
  it.each([
    ['こんにちは1', 'こんにちは1'],
    ['こんにちは2:', String.raw`こんにちは2\:`],
    ['こんにちは3=', String.raw`こんにちは3\=`],
    ['こんにちは4\t', String.raw`こんにちは4\t`],
    ['こんにちは5 ', 'こんにちは5 '],
    ['  こんにちは6', String.raw`\  こんにちは6`],
    ['#こんにちは7', String.raw`\#こんにちは7`],
    ['!こんにちは8#', String.raw`\!こんにちは8\#`],
    ['こん  にちは9', 'こん  にちは9'],
    ['こんにちは10\n', String.raw`こんにちは10\n`],
    ['こ\r\f\n\tんにちは11', String.raw`こ\r\f\n\tんにちは11`],
    ['\\こんにちは12\\', '\\\\こんにちは12\\\\'],
  ])('should escape key "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeValue(key)
    expect(result).toEqual(expected)
  })
})

describe('The property ISO-8859-1 compatible encoding value escaping', () => {
  it.each([
    ['foo1', 'foo1'],
    ['foo2:', String.raw`foo2\:`],
    ['foo3=', String.raw`foo3\=`],
    ['foo4\t', String.raw`foo4\t`],
    ['foo5 ', 'foo5 '],
    [' foo6', String.raw`\ foo6`],
    ['#foo7', String.raw`\#foo7`],
    ['!foo8#', String.raw`\!foo8\#`],
    ['fo  o9', 'fo  o9'],
    ['  fo  o10 ', String.raw`\  fo  o10 `],
    ['foo11\n', String.raw`foo11\n`],
    ['f\r\f\n\too12', String.raw`f\r\f\n\too12`],
    ['\\foo13\\', '\\\\foo13\\\\'],
    ['\0\u0001', String.raw`\u0000\u0001`],
    ['\u3053\u3093\u306B\u3061\u306F', String.raw`\u3053\u3093\u306b\u3061\u306f`],
    ['こんにちは', String.raw`\u3053\u3093\u306b\u3061\u306f`],
  ])('should escape value "%s" as "%s"', (key: string, expected: string) => {
    const result = escapeValue(key, true)
    expect(result).toEqual(expected)
  })
})

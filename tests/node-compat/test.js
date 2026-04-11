/**
 * Minimal compatibility test for Node.js 0.10+.
 *
 * Validates that the compiled CJS output works on the oldest supported
 * Node.js version. Must use only ES5 syntax (var, no arrow functions,
 * no template literals).
 */

/* eslint-disable no-var, prefer-arrow-callback, unicorn/prefer-module */

var getProperties = require('/dist/cjs/index.js').getProperties

var input = [
  '# Comment line',
  'key = value',
  'hello = world',
  'unicode = M\\u00FCnchen',
  'multi = line\\',
  '  continues',
  'escaped\\=key = works',
  'duplicate = first',
  'duplicate = second',
].join('\n')

var result = getProperties(input)

var pass = 0
var fail = 0

function check(name, actual, expected) {
  if (actual === expected) {
    pass++
  } else {
    fail++
    console.log(
      '  FAIL: ' +
        name +
        ' — expected ' +
        JSON.stringify(expected) +
        ', got ' +
        JSON.stringify(actual)
    )
  }
}

check('basic key=value', result.key, 'value')
check('hello', result.hello, 'world')
check('unicode escape', result.unicode, 'M\u00FCnchen')
check('multiline continuation', result.multi, 'linecontinues')
check('escaped = in key', result['escaped=key'], 'works')
check('duplicate keys (last wins)', result.duplicate, 'second')
check('comment skipped', result['# Comment line'], undefined)

if (fail > 0) {
  console.log('\nNode ' + process.version + ': ' + pass + '/' + (pass + fail) + ' passed — FAILED')
  process.exit(1)
} else {
  console.log('Node ' + process.version + ': ' + pass + '/' + (pass + fail) + ' passed')
}

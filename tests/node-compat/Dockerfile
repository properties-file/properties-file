# Verifies that the compiled output works on Node.js 0.10 (2013).
#
# Usage:
#   docker build -f tests/node-compat/Dockerfile .
#
# This test runs against the compiled dist/ output (not source), confirming
# that the ES5 downleveling produces code compatible with the oldest
# supported Node.js version.

FROM node:0.10

COPY dist/cjs /dist/cjs
COPY tests/node-compat/test.js /test.js

RUN node /test.js

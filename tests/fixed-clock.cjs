'use strict';
// Only loaded with --require by the isolated integration test.
const OriginalDate = Date;
const fixed = OriginalDate.parse(process.env.LIBSEAT_TEST_NOW);
if (!Number.isFinite(fixed)) throw Error('Missing test clock');
global.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
  static now() { return fixed; }
};

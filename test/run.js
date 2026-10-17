#!/usr/bin/env node
/* Testlauf: Store (Mock-Transport), Velocity-Render + Lint, Macro im jsdom (inkl. Inline-Selbsttest).
 * Aufruf: npm test  (bzw. node test/run.js). Exit-Code 1 bei Fehlern. */
"use strict";
var H = require("./helpers");
Promise.resolve()
  .then(function () { return require("./store.test.js")(); })
  .then(function () { return require("./velocity.test.js")(); })
  .then(function () { return require("./macro.test.js")(); })
  .then(function () { process.exit(H.summary("belegios") ? 1 : 0); })
  .catch(function (e) { console.error("Testlauf abgebrochen:", e && e.stack || e); H.summary("belegios"); process.exit(1); });

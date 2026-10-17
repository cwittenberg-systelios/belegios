/* Velocity-Disziplin: neue/geänderte Zeilen dürfen keine Velocity-Syntax einschleppen,
 * das Template muss rendern, der Store-Block muss unverändert durch Velocity kommen und
 * das gerenderte Inline-Skript muss syntaktisch gültiges JS sein. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var H = require("./helpers"), ok = H.ok, eq = H.eq;

// Gefährliche Muster (Velocity 1.7, Confluence): Direktiven, Kommentare, Referenzen
var DIRECTIVES = /#\{?(set|if|elseif|else|end|foreach|include|parse|macro|stop|break|evaluate|define)\b/;
var HAZARDS = [
  { name: "Velocity-Zeilenkommentar ##", re: /##/ },
  { name: "Velocity-Blockkommentar #* / *#", re: /#\*|\*#/ },
  { name: "Velocity-Direktive", re: DIRECTIVES },
  { name: "Raute vor geschweifter Klammer", re: /#\{/ },
  { name: "Velocity-Referenz ($ vor Buchstabe/{/!)", re: /\$!?\{?[A-Za-z_]/ },
  { name: "Raute vor Buchstabe (z. B. CSS-ID oder Anker)", re: /#[A-Za-z_]/ }
];

module.exports = function () {
  H.group("Velocity");
  var src = H.vmSource();
  var base = fs.readFileSync(path.join(__dirname, "fixtures", "belegios-v1.vm"), "utf8");
  var baseLines = {}; base.split("\n").forEach(function (l) { baseLines[l] = 1; });

  // 1) Lint: nur Zeilen, die es in Format-1-Version (main) schon gab, dürfen Velocity-Muster tragen.
  //    Ausnahme: bewusst gesetzte, gerenderte Instanz-IDs im HTML-Teil.
  var allowNew = [/id="bp-build-\$\{paramGruppenbezeichnung\}"/];
  var offenders = [];
  src.split("\n").forEach(function (line, i) {
    if (baseLines[line]) return;
    if (allowNew.some(function (re) { return re.test(line); })) return;
    // HTML-Entities (&#x270e;) und Farbwerte (#fff) sind harmlos
    var probe = line.replace(/&#x?[0-9a-fA-F]+;/g, "").replace(/#[0-9a-fA-F]{3,8}\b/g, "");
    HAZARDS.forEach(function (hz) { if (hz.re.test(probe)) offenders.push((i + 1) + ": " + hz.name + " — " + line.trim().slice(0, 90)); });
  });
  eq("Lint: keine neuen Velocity-Muster in geänderten Zeilen", offenders, []);

  var block = H.storeBlock(src), blockHaz = [];
  HAZARDS.forEach(function (hz) { if (hz.re.test(block.replace(/#[0-9a-fA-F]{3,8}\b/g, ""))) blockHaz.push(hz.name); });
  eq("Lint: Store-Block frei von Velocity-Mustern", blockHaz, []);

  // 2) Rendern (velocityjs als Näherung an Confluence-Velocity 1.7)
  var out;
  try { out = H.render(src, { inst: "gruppe5", pageId: "4711" }); ok("Template rendert", true); }
  catch (e) { ok("Template rendert", false, e.message); return; }
  ok("Store-Block kommt unverändert durch Velocity", out.indexOf(block) >= 0);
  var scripts = out.match(/<script>([\s\S]*?)<\/script>/g) || [];
  eq("genau ein Inline-Skript", scripts.length, 1);
  try { new vm.Script(scripts[0].replace(/^<script>|<\/script>$/g, ""), { filename: "inline.js" }); ok("gerendertes Inline-Skript ist gültiges JS", true); }
  catch (e) { ok("gerendertes Inline-Skript ist gültiges JS", false, e.message); }
  ok("Instanz-IDs gerendert (bp-root-gruppe5, bp-build-gruppe5)", /id="bp-root-gruppe5"/.test(out) && /id="bp-build-gruppe5"/.test(out));
  ok("pageId gerendert", /data-page-id="4711"/.test(out));
  ok("CSS-ID-Selektoren via Escape erhalten (#footer, #poweredby)", out.indexOf("#footer,") >= 0 && out.indexOf("#poweredby,") >= 0);
  var js = scripts[0];
  var stray = (js.match(/\$\{?(?:paramGruppenbezeichnung|content|H|D)\b/g) || []);
  // in den Velocity-Hinweiskommentaren dürfen die Muster absichtlich als Text stehen
  var codeOnly = js.split("\n").filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n");
  eq("keine unaufgelösten Velocity-Referenzen im JS-Code", (codeOnly.match(/\$\{?(?:paramGruppenbezeichnung|content|H|D)\b/g) || []), []);
  ok("Build-Version im gerenderten Skript", /var BUILD_VERSION = '2\.0\.0/.test(js), stray.length + " Kommentar-Treffer");

  // 3) Jede Zeile ohne $/# muss 1:1 im gerenderten Ergebnis stehen (Velocity hat nichts verändert)
  var outLines = {};
  (out + "\n" + H.render(src, { inst: "" })).split("\n").forEach(function (l) { outLines[l] = (outLines[l] || 0) + 1; });
  var changed = src.split("\n").filter(function (l) { return l.indexOf("$") < 0 && l.indexOf("#") < 0 && !outLines[l]; });
  eq("Zeilen ohne $/# unverändert gerendert", changed.slice(0, 5), []);
};

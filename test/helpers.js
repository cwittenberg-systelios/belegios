/* Test-Helfer: Mini-Runner, Mock-Transport (Versionen, 409, Hooks, Bereichssperre, Listing),
 * Extraktion des Store-Blocks aus belegios.vm und Velocity-Rendering des Macros. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var ROOT = path.join(__dirname, "..");
var VM_FILE = path.join(ROOT, "belegios.vm");

/* ---------- Mini-Runner ---------- */
var results = [], section = "";
function group(name) { section = name; console.log("· " + name); }
function ok(name, cond, info) {
  results.push({ g: section, name: name, ok: !!cond, info: info || "" });
  if (!cond) console.log("  ✗ " + name + (info ? "  — " + info : ""));
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), "ist " + JSON.stringify(a) + ", erwartet " + JSON.stringify(b)); }
function summary(label) {
  var pass = results.filter(function (r) { return r.ok; }).length;
  console.log((pass === results.length ? "✓ " : "✗ ") + label + ": " + pass + "/" + results.length + " Assertions grün");
  return results.length - pass;
}

/* ---------- Mock-Transport ----------
 * store[key] = { value: <JSON-String>, version }
 * Hooks: beforePut(key)/beforeGet(key) (dürfen Promises liefern oder werfen)
 * failPutMatching (400 vor Commit), failAfterCommitMatching (500 nach Commit),
 * failUpdateMatching (500 ohne Commit, nur Update bestehender Keys),
 * spaceLocked[key] (500 + spaceMismatch beim Update eines BESTEHENDEN Keys),
 * failList (Listing schlägt fehl). */
function MockTransport() {
  this.store = {}; this.writes = 0; this.log = [];
  this.beforePut = null; this.beforeGet = null;
  this.failPutMatching = null; this.failAfterCommitMatching = null; this.failUpdateMatching = null;
  this.spaceLocked = null; this.failList = false;
}
MockTransport.prototype.get = function (key) {
  var self = this;
  return Promise.resolve().then(function () { return self.beforeGet ? self.beforeGet(key) : null; }).then(function () {
    var e = self.store[key]; return e ? { value: JSON.parse(e.value), version: e.version } : null;
  });
};
MockTransport.prototype.put = function (key, value, expectedVersion) {
  var self = this;
  return Promise.resolve().then(function () { return self.beforePut ? self.beforePut(key) : null; }).then(function () {
    self.writes++; self.log.push("put " + key);
    if (self.failPutMatching && self.failPutMatching.test(key)) { var fe = new Error("HTTP 400 bei PUT " + key); fe.status = 400; throw fe; }
    var e = self.store[key], cur = e ? e.version : 0;
    if (expectedVersion !== undefined && expectedVersion !== cur) { var err = new Error("conflict"); err.status = 409; throw err; }
    if (e && self.spaceLocked && self.spaceLocked[key]) {
      var se = new Error("HTTP 500 bei PUT " + key); se.status = 500; se.spaceMismatch = true;
      se.detail = "java.lang.IllegalArgumentException: Can't add an owner from another space"; throw se;
    }
    if (e && self.failUpdateMatching && self.failUpdateMatching.test(key)) { var ue = new Error("HTTP 500 bei PUT " + key); ue.status = 500; throw ue; }
    var nv = cur + 1; self.store[key] = { value: JSON.stringify(value), version: nv };
    if (self.failAfterCommitMatching && self.failAfterCommitMatching.test(key)) { var ce = new Error("HTTP 500 bei PUT " + key); ce.status = 500; throw ce; }
    return { version: nv };
  });
};
MockTransport.prototype.del = function (key) { this.log.push("del " + key); delete this.store[key]; return Promise.resolve(true); };
MockTransport.prototype.list = function () {
  if (this.failList) { var e = new Error("HTTP 500 bei Property-Liste"); e.status = 500; return Promise.reject(e); }
  return Promise.resolve(Object.keys(this.store));
};
MockTransport.prototype.keys = function () { return Object.keys(this.store).sort(); };
MockTransport.prototype.val = function (key) { var e = this.store[key]; return e ? JSON.parse(e.value) : undefined; };

/* ---------- Store-Block aus dem Macro ziehen und in Node auswerten ---------- */
function vmSource() { return fs.readFileSync(VM_FILE, "utf8"); }
function storeBlock(src) {
  src = src || vmSource();
  var a = src.indexOf("/* BELEGIOS-STORE-BEGIN */"), b = src.indexOf("/* BELEGIOS-STORE-END */");
  if (a < 0 || b < 0) throw new Error("Store-Block-Marker nicht gefunden");
  return src.slice(a, b);
}
function loadStore() {
  var ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Promise: Promise, fetch: function () { throw new Error("kein fetch im Test"); } };
  vm.createContext(ctx);
  vm.runInContext(storeBlock() + "\nthis.BelegiosStore = BelegiosStore;", ctx, { filename: "belegios.vm#store" });
  return ctx.BelegiosStore;
}

/* ---------- Velocity-Rendering ----------
 * velocityjs 2.x versteht das (in Confluence gültige) Muster "$D{H}" nicht; es steht nur in
 * Kommentaren und wird vorab auf "${D}{H}" normalisiert (rendert identisch zu "${'$'}{H}"). */
function render(src, params) {
  var V = require("velocityjs");
  src = (src || vmSource()).split("$D{").join("${D}{");
  params = params || {};
  var ctx = {
    paramGruppenbezeichnung: ("inst" in params) ? params.inst : "gruppe5",
    paramTherapeutenVerbal: params.thv || "", paramTherapeutenNonVerbal: params.thnv || "",
    content: { getId: function () { return params.pageId || "4711"; }, getUrlPath: function () { return "/display/KLINIK/Belegung"; } }
  };
  return V.render(src, ctx);
}

/* ---------- Browser-Umgebung (jsdom) mit gerendertem Macro ---------- */
// opts: { pages:[{inst, pageId}], transport, admin, canEdit, vmSrc }
function browserEnv(opts) {
  opts = opts || {};
  var JSDOM = require("jsdom").JSDOM;
  var pages = opts.pages || [{ inst: "gruppe5" }];
  var html = "<!doctype html><html><head></head><body>" +
    (opts.canEdit === false ? "" : "<a id='editPageLink' href='#'>Bearbeiten</a>") +
    pages.map(function (p) { return render(opts.vmSrc, p); }).join("\n") + "</body></html>";
  var jsdomLib = require("jsdom"), vc = new jsdomLib.VirtualConsole();
  // mailto-Navigation (Versand) kann jsdom nicht – diese eine Meldung ignorieren, alles andere zeigen
  vc.on("jsdomError", function (e) { if (!/navigation/i.test(e && e.message)) console.error("jsdom:", e && e.message); });
  var dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc, url: "https://wiki.example/pages/viewpage.action?pageId=4711" });
  var w = dom.window;
  w.confirm = function () { return true; };
  var logs = [];
  ["log", "warn", "error"].forEach(function (m) { w.console[m] = function () { logs.push(m + ": " + Array.prototype.join.call(arguments, " ")); }; });
  w.AJS = { params: { pageId: "4711" }, contextPath: function () { return ""; }, toInit: function (f) { f(); },
            Meta: { get: function (k) { return k === "remote-user" ? (opts.admin ? "admin" : "user") : null; } } };
  w.fetch = makeFetch(opts.transport, opts.admin);
  w.MouseEvent = w.MouseEvent || dom.window.MouseEvent;
  // Inline-Skripte der Reihe nach ausführen (wie im Browser: jedes sieht sein Macro als letztes .bp-root)
  var scripts = w.document.querySelectorAll("script");
  var roots = Array.prototype.slice.call(w.document.querySelectorAll(".bp-root[data-inst-id]"));
  for (var i = 0; i < scripts.length; i++) {
    // "letztes .bp-root" = Root des eigenen Macros: nachfolgende Roots kurz ausblenden
    var later = roots.slice(i + 1);
    later.forEach(function (r) { r.removeAttribute("data-inst-id"); r.setAttribute("data-inst-hold", r.id.replace(/^bp-root-/, "")); });
    w.eval(scripts[i].textContent);
    later.forEach(function (r) { r.setAttribute("data-inst-id", r.getAttribute("data-inst-hold")); r.removeAttribute("data-inst-hold"); });
  }
  return { window: w, dom: dom, logs: logs };
}

// fetch-Attrappe: bildet die Confluence-REST-Antworten auf den Mock-Transport ab
function makeFetch(mt, admin) {
  function resp(status, body) {
    return { status: status, ok: status >= 200 && status < 300,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(typeof body === "string" ? body : JSON.stringify(body || "")); } };
  }
  return function (url, init) {
    init = init || {};
    var method = (init.method || "GET").toUpperCase();
    var u = String(url);
    if (/\/rest\/api\/user\/memberof/.test(u)) return Promise.resolve(resp(200, { results: admin ? [{ name: "confluence-administrators" }] : [] }));
    var m = /\/rest\/api\/content\/([^/?]+)\/property(?:\/([^?]*))?(\?.*)?$/.exec(u);
    if (!m) return Promise.resolve(resp(200, { _links: {}, id: "4711" }));
    var key = m[2] ? decodeURIComponent(m[2]) : null;
    if (method === "GET" && !key) {
      return mt.list().then(function (keys) { return resp(200, { results: keys.map(function (k) { return { key: k }; }), size: keys.length, limit: 200 }); },
                            function (e) { return resp(e.status || 500, "list failed"); });
    }
    if (method === "GET") return mt.get(key).then(function (r) { return r ? resp(200, { key: key, value: r.value, version: { number: r.version } }) : resp(404, ""); },
                                                   function (e) { return resp(e.status || 500, e.message); });
    if (method === "DELETE") return mt.del(key).then(function () { return resp(204, ""); });
    var body = JSON.parse(init.body);
    var k = body.key, expected = method === "POST" ? 0 : body.version.number - 1;
    return mt.put(k, body.value, expected).then(function (r) { return resp(200, { key: k, version: { number: r.version } }); },
      function (e) { return resp(e.status || 500, e.detail || e.message); });
  };
}

function tick(n) { var p = Promise.resolve(); for (var i = 0; i < (n || 30); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); }); return p; }

module.exports = { ok: ok, eq: eq, group: group, summary: summary, results: results, MockTransport: MockTransport,
  loadStore: loadStore, storeBlock: storeBlock, vmSource: vmSource, render: render, browserEnv: browserEnv, tick: tick, ROOT: ROOT, VM_FILE: VM_FILE };

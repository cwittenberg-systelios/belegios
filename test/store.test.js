/* Unit-Tests des in belegios.vm eingebetteten Stores (Mock-Transport).
 * Pflichtfälle aus der Übergabe §3.2 + Altformat-Migration + Platzhalter + zwei Instanzen. */
"use strict";
var H = require("./helpers"), ok = H.ok, eq = H.eq, MockTransport = H.MockTransport;
var B = H.loadStore();

var PAGE = "4711";
function legacyKey(inst) { return "belegungsplaner_" + PAGE + "_" + inst; }
function prefix(inst) { return "belegios_" + PAGE + "_" + inst; }
function emptyState(inst) { return function () { return { schemaVersion: 1, gruppenbezeichnung: inst, lastModified: new Date().toISOString(), clients: [] }; }; }
function mk(mt, inst) {
  inst = inst || "gruppe5";
  return new B.Store(mt, { prefix: prefix(inst), legacyKey: legacyKey(inst), build: "test", emptyModel: emptyState(inst) });
}
function client(id, name) {
  return { id: id, name: name, aufnahmedatum: "2026-10-01", kostenzusage_traeger: "PKV", kostenzusage_bis: "2026-11-30",
           kostenzusage_detail: "Kostenzusage \"Müller\" ß€", verlaengerung_status: "keine", entlassdatum: null };
}
// Replay-Helfer wie im Macro
function rAdd(c) { return function (b) { b.clients = b.clients || []; if (!b.clients.some(function (x) { return x.id === c.id; })) b.clients.push(JSON.parse(JSON.stringify(c))); return b; }; }
function rSet(id, f) { return function (b) { var x = b.clients.filter(function (c) { return c.id === id; })[0]; if (x) Object.assign(x, f); return b; }; }
function rTop(o) { return function (b) { Object.assign(b, o); return b; }; }
function addTo(st, model, c) { model.clients.push(c); return st.save(model, rAdd(c)); }
function ids(m) { return (m.clients || []).map(function (c) { return c.id; }).sort(); }
function manKey(inst) { return prefix(inst || "gruppe5") + ".m"; }
function chunkKeys(mt, inst) { var K = new B.Keys(prefix(inst || "gruppe5")); return mt.keys().filter(function (k) { return !!K.parseChunk(k); }); }

function seeded(inst) {
  var mt = new MockTransport(), s = mk(mt, inst);
  return s.load().then(function (m) { return addTo(s, m, client("a", "Anna")); })
    .then(function (r) { return addTo(s, r.model, client("b", "Bert")); })
    .then(function () { return s.pending; }).then(function () { return mt; });
}

module.exports = function () {
  H.group("Store (belegios.vm, Mock-Transport)");
  return Promise.resolve()

  /* --- Chunking + Schlüssel --- */
  .then(function () {
    var txt = JSON.stringify({ x: "Müller \"Örtchen\" ß€".repeat(3000) });
    var chunks = B.splitChunks(txt, 4000);
    var maxBytes = Math.max.apply(null, chunks.map(function (c) { return Buffer.byteLength(JSON.stringify(c), "utf8"); }));
    ok("splitChunks: jeder Chunk ≤ Limit nach Escaping/UTF-8", maxBytes <= 4002, "max=" + maxBytes);
    eq("splitChunks: verlustfrei", chunks.join(""), txt);
    var K = new B.Keys("belegios_1_g.5");
    eq("Keys: Chunk-Key parsebar", K.parseChunk(K.chunk(7, 2, "abc123")), { gen: 7, token: "abc123", i: 2 });
    eq("Keys: Manifest-Folge .m -> .m.2 -> .m.3", [K.next("belegios_1_g.5.m"), K.next("belegios_1_g.5.m.2")], ["belegios_1_g.5.m.2", "belegios_1_g.5.m.3"]);
    ok("Keys: Sonderzeichen im Präfix werden escaped", K.parseChunk("belegios_1_gX5.c-1-a-0") === null && !K.manRe.test("belegios_1_gX5.m"));
  })

  /* --- Leere Seite: kein Manifest, kein Altschlüssel -> leer (erlaubt), erster Save legt an --- */
  .then(function () {
    var mt = new MockTransport(), s = mk(mt);
    return s.load().then(function (m) {
      ok("leer: Manifest + Altschlüssel fehlen -> leeres Modell, schreibbar", m.clients.length === 0 && !s.readOnly);
      return addTo(s, m, client("n1", "Neu"));
    }).then(function (r) {
      ok("leer: erster Save legt Manifest an", r.ok && mt.val(manKey()).gen === 1);
      ok("leer: Altschlüssel wird mit Platzhalter versiegelt", B.isGuard(mt.val(legacyKey("gruppe5"))));
    });
  })

  /* --- Großer Stand wird gechunkt und vollständig gelesen --- */
  .then(function () {
    var mt = new MockTransport(), s = mk(mt), m0;
    return s.load().then(function (m) {
      m0 = m; for (var i = 0; i < 400; i++) m.clients.push(client("c" + i, "Klient:in Nummer " + i + " – Ärger"));
      return s.save(m, null);
    }).then(function () {
      var man = mt.val(manKey());
      ok("Chunking: Stand > 32 kB in mehrere Chunks", man.count > 1, "count=" + man.count);
      ok("Chunking: jeder Chunk-Wert < 32 kB", chunkKeys(mt).every(function (k) { return Buffer.byteLength(mt.store[k].value, "utf8") < 32000; }));
      return mk(mt).load();
    }).then(function (m) { eq("Chunking: alle 400 Einträge geladen", m.clients.length, 400); });
  })

  /* --- Pflicht: zwei Schreiber verschachtelt -> beide Änderungen überleben, keine Verlierer-Chunks --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var A = mk(mt), Bs = mk(mt), mA, mB;
    return A.load().then(function (m) { mA = m; return Bs.load(); }).then(function (m) {
      mB = m;
      var cA = client("xa", "Von A"), cB = client("xb", "Von B"), fired = false, pB;
      mA.clients.push(cA); mB.clients.push(cB);
      mt.beforePut = function (key) {
        if (fired || !/\.c-\d+-[a-z0-9]+-\d+$/.test(key)) return null;
        fired = true; mt.beforePut = null;
        return Bs.save(mB, rAdd(cB));      // B schreibt komplett, während A schon das Manifest gelesen hat
      };
      return A.save(mA, rAdd(cA));
    }).then(function (rA) {
      ok("Interleaving: A meldet Erfolg nach Merge", rA.ok && rA.merged);
      return mk(mt).load();
    }).then(function (m) {
      ok("Interleaving: Änderung von A überlebt", ids(m).indexOf("xa") >= 0);
      ok("Interleaving: Änderung von B überlebt", ids(m).indexOf("xb") >= 0);
      ok("Interleaving: Bestand bleibt", ids(m).indexOf("a") >= 0 && ids(m).indexOf("b") >= 0);
      var K = new B.Keys(prefix("gruppe5")), perGen = {};
      chunkKeys(mt).forEach(function (k) { var p = K.parseChunk(k); if (!/^alt/.test(p.token)) (perGen[p.gen] = perGen[p.gen] || {})[p.token] = 1; });
      ok("Interleaving: keine Verlierer-Chunks (je Generation genau ein Satz)", Object.keys(perGen).every(function (g) { return Object.keys(perGen[g]).length === 1; }), JSON.stringify(perGen));
    });
  })

  /* --- 409-Replay: Feld-Delta auf fremden Stand, Fremdänderung am selben Klienten (anderes Feld) bleibt --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var A = mk(mt), O = mk(mt), mA;
    return A.load().then(function (m) { mA = m; return O.load(); }).then(function (mO) {
      mO.clients[0].kostenzusage_bis = "2026-12-24";
      return O.save(mO, rSet("a", { kostenzusage_bis: "2026-12-24" }));
    }).then(function () {
      mA.clients[0].entlassdatum = "2026-12-01";
      return A.save(mA, rSet("a", { entlassdatum: "2026-12-01" }));
    }).then(function (r) {
      var a = r.model.clients.filter(function (c) { return c.id === "a"; })[0];
      ok("409-Replay: eigenes Feld gesetzt, fremdes Feld bleibt", r.merged && a.entlassdatum === "2026-12-01" && a.kostenzusage_bis === "2026-12-24");
    });
  })

  /* --- Dauerkonflikt -> Fehler (ok:false), danach Retry ok --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var s = mk(mt), O = mk(mt), n = 0, inHook = false, m0;
    return s.load().then(function (m) { m0 = m; return O.load(); }).then(function () {
      var c = client("dk", "Dauer");
      m0.clients.push(c);
      mt.beforePut = function (key) {
        if (inHook || key !== manKey() || n >= 3) return null;
        n++; inHook = true;
        return O.load().then(function (mo) { return addTo(O, mo, client("o" + n, "Fremd " + n)); }).then(function () { inHook = false; });
      };
      return s.save(m0, rAdd(c)).then(function () { return null; }, function (e) { return e; });
    }).then(function (e) {
      mt.beforePut = null;
      ok("Dauerkonflikt -> Rejection mit Konflikt-Text", e && e.conflict && /konflikt/i.test(e.message));
      return s.save(m0, rAdd(client("dk", "Dauer")));
    }).then(function (r) {
      ok("Dauerkonflikt: Retry gelingt", r.ok);
      return mk(mt).load();
    }).then(function (m) { ok("Dauerkonflikt: alle Fremd- und eigenen Einträge da", ["dk", "o1", "o2", "o3"].every(function (id) { return ids(m).indexOf(id) >= 0; })); });
  })

  /* --- Pflicht: 500 nach Commit -> Erfolg erkannt, Daten ladbar --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var s = mk(mt);
    return s.load().then(function (m) {
      mt.failAfterCommitMatching = /\.m$/;
      return addTo(s, m, client("h1", "Hotfix"));
    }).then(function (r) {
      mt.failAfterCommitMatching = null;
      ok("500 nach Commit: als Erfolg erkannt", r.ok && !mt.store[prefix("gruppe5") + ".m.2"]);
      var F = mk(mt);
      return F.load().then(function (m) { ok("500 nach Commit: Daten vollständig ladbar", !F.recovered && ids(m).indexOf("h1") >= 0); });
    });
  })

  /* --- Pflicht: 500 ohne Commit (Chunk-Fehler) -> Fehler, Daten unverändert, Retry klappt --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var s = mk(mt), before = mt.store[manKey()].value, m0;
    return s.load().then(function (m) {
      m0 = m; m.clients.push(client("h2", "Retry"));
      mt.failPutMatching = /\.c-\d+-[a-z0-9]+-\d+$/;
      return s.save(m, rAdd(client("h2", "Retry"))).then(function () { return null; }, function (e) { return e; });
    }).then(function (e) {
      mt.failPutMatching = null;
      ok("Chunk-Fehler -> Rejection mit Status", e && e.status === 400);
      ok("Chunk-Fehler: Manifest unverändert", mt.store[manKey()].value === before);
      var man = JSON.parse(before), K = new B.Keys(prefix("gruppe5"));
      eq("Chunk-Fehler: keine halb geschriebenen Chunks übrig", chunkKeys(mt).filter(function (k) { return K.parseChunk(k).gen > man.gen; }), []);
      return s.save(m0, rAdd(client("h2", "Retry")));
    }).then(function (r) { ok("Chunk-Fehler: Retry gelingt", r.ok); });
  })
  /* --- 500 ohne Commit beim Manifest (keine Bereichssperre): Umzugsversuch, Daten konsistent --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var s = mk(mt), m0;
    return s.load().then(function (m) {
      m0 = m;
      mt.failUpdateMatching = /\.m(\.\d+)?$/; mt.failPutMatching = /\.m\.\d+$/;   // Update UND Neuanlage scheitern
      m.clients.push(client("h3", "x"));
      return s.save(m, rAdd(client("h3", "x"))).then(function () { return null; }, function (e) { return e; });
    }).then(function (e) {
      ok("Manifest-500 ohne Commit -> Rejection", !!e && e.status >= 400);
      var F = mk(mt);
      return F.load().then(function (m) {
        ok("Manifest-500 ohne Commit: Stand unverändert ladbar", !F.recovered && ids(m).join() === "a,b");
        mt.failUpdateMatching = null; mt.failPutMatching = null;
        return s.save(m0, rAdd(client("h3", "x")));
      });
    }).then(function (r) { ok("Manifest-500 ohne Commit: Retry gelingt", r.ok); });
  })

  /* --- Pflicht: Manifest zeigt auf gelöschten Chunk -> Rückfall (schreibgeschützt), kein leeres Speichern --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var man = mt.val(manKey()), K = new B.Keys(prefix("gruppe5"));
    delete mt.store[K.chunk(man.gen, 0, man.token)];
    var s = mk(mt), w0 = mt.writes;
    return s.load().then(function (m) {
      ok("Chunk weg: Rückfall auf älteren Stand", s.recovered && s.recovered.fromGen === man.gen - 1 && ids(m).join() === "a");
      ok("Chunk weg: Rückfall-Stand schreibgeschützt", s.readOnly);
      return s.save(m, rAdd(client("z", "z"))).then(function () { return null; }, function (e) { return e; });
    }).then(function (e) {
      ok("Chunk weg: Speichern verweigert, nichts geschrieben", !!e && mt.writes === w0 && mt.val(manKey()).gen === man.gen);
      return s.describeSets();
    }).then(function (d) {
      var prev = d.rows.filter(function (r) { return r.ok && !r.current && r.gen === man.gen - 1; })[0];
      ok("Datenstände: unlesbarer aktueller Stand markiert", d.rows.some(function (r) { return r.gen === man.gen && !r.ok; }));
      return s.restoreFrom(prev.gen, prev.token, prev.count);
    }).then(function (r) {
      ok("Admin-Wiederherstellung: neue Generation, schreibbar", r.ok && r.gen === man.gen + 1 && !s.readOnly && !s.recovered);
      return mk(mt).load();
    }).then(function (m) { ok("nach Wiederherstellung: sauberes Laden", ids(m).join() === "a"); });
  })
  /* --- Chunk weg und kein älterer Stand -> Ladefehler --- */
  .then(function () {
    var mt = new MockTransport();
    mt.store[manKey()] = { value: JSON.stringify({ gen: 3, count: 1, token: "tok" }), version: 3 };
    var s = mk(mt);
    return s.load().then(function () { ok("ohne Historie: Ladefehler", false); }, function (e) {
      ok("ohne Historie: Ladefehler, schreibgeschützt, kein leeres Modell", e.isLoadError && s.readOnly && mt.writes === 0);
    });
  })
  /* --- Kaputtes JSON -> Rückfall bzw. Ladefehler --- */
  .then(function () {
    var mt = new MockTransport(), K = new B.Keys(prefix("gruppe5"));
    mt.store[manKey()] = { value: JSON.stringify({ gen: 1, count: 1, token: "t1" }), version: 1 };
    mt.store[K.chunk(1, 0, "t1")] = { value: JSON.stringify("{\"clients\":["), version: 1 };
    var s = mk(mt);
    return s.load().then(function () { ok("kaputtes JSON -> Ladefehler", false); }, function (e) {
      ok("kaputtes JSON -> Ladefehler + readOnly, nichts geschrieben", e.isLoadError && s.readOnly && mt.writes === 0);
    });
  })

  /* --- Pflicht: Lesefehler beim GET -> Ladefehler, KEIN Rückfall --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var man = mt.val(manKey()), K = new B.Keys(prefix("gruppe5"));
    mt.beforeGet = function (key) { if (key === K.chunk(man.gen, 0, man.token)) { var e = new Error("HTTP 500 bei GET"); e.status = 500; throw e; } return null; };
    var s = mk(mt);
    return s.load().then(function () { ok("GET-500 -> Ladefehler", false); }, function (e) {
      mt.beforeGet = null;
      ok("GET-500 -> Ladefehler, schreibgeschützt, kein Rückfall", s.readOnly && !s.recovered && /500/.test(e.message));
    });
  })
  .then(function () { return seeded(); }).then(function (mt) {
    mt.failList = true;
    var s = mk(mt);
    return s.load().then(function () { ok("Listing-500 -> Ladefehler", false); }, function (e) {
      ok("Listing-500 -> Ladefehler (nie 'keine Daten' raten)", s.readOnly && /Property-Liste/.test(e.message));
    });
  })
  .then(function () {
    var mt = new MockTransport();
    mt.beforeGet = function (key) { if (key === legacyKey("gruppe5")) { var e = new Error("HTTP 503 bei GET"); e.status = 503; throw e; } };
    var s = mk(mt);
    return s.load().then(function () { ok("Altschlüssel-GET-503 -> Ladefehler", false); }, function () { ok("Altschlüssel-GET-503 -> Ladefehler statt leer", s.readOnly); });
  })

  /* --- Chunk fehlt kurzzeitig (Zeiger gerade umgebogen) -> Retry liefert neuen Stand --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var man0 = mt.val(manKey()), K = new B.Keys(prefix("gruppe5")), W = mk(mt), R = mk(mt), armed = true;
    return W.load().then(function (mw) {
      mw.clients.push(client("e9", "Neu"));
      mt.beforeGet = function (key) {
        if (armed && key === K.chunk(man0.gen, 0, man0.token)) {
          armed = false;
          return W.save(mw, rAdd(client("e9", "Neu"))).then(function () { delete mt.store[K.chunk(man0.gen, 0, man0.token)]; });
        }
        return null;
      };
      return R.load();
    }).then(function (m) {
      mt.beforeGet = null;
      ok("Chunk-Verlust beim Lesen: Retry liefert neuen Stand", ids(m).indexOf("e9") >= 0 && !R.readOnly && !R.recovered);
    });
  })

  /* --- Pflicht: Bereichssperre -> Umzug .m -> .m.2 -> .m.3, Laden + Speichern ok --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var p = prefix("gruppe5");
    mt.spaceLocked = {}; mt.spaceLocked[p + ".m"] = true; mt.spaceLocked[legacyKey("gruppe5")] = true;
    var s = mk(mt);
    return s.load().then(function (m) { return addTo(s, m, client("sp1", "Umzug 1")); }).then(function (r) {
      ok("Bereichswechsel: Speichern über neuen Manifest-Schlüssel", r.ok && r.migratedTo === p + ".m.2" && !!mt.store[p + ".m.2"]);
      var F = mk(mt);
      return F.load().then(function (m) {
        ok("Bereichswechsel: Laden findet .m.2", F.manifestKey === p + ".m.2" && ids(m).indexOf("sp1") >= 0);
        return addTo(F, m, client("sp2", "Umzug 2")).then(function (r2) {
          ok("Bereichswechsel: weiteres Speichern aktualisiert .m.2", r2.ok && mt.val(p + ".m.2").gen === r2.gen && mt.store[p + ".m.2"].version === 2);
          mt.spaceLocked[p + ".m.2"] = true;
          return addTo(F, r2.model, client("sp3", "Umzug 3"));
        });
      });
    }).then(function (r3) {
      var G = mk(mt);
      return G.load().then(function (m) {
        ok("Bereichswechsel 2x: Umzug auf .m.3, alle Einträge da", r3.ok && G.manifestKey === p + ".m.3" && ["sp1", "sp2", "sp3"].every(function (id) { return ids(m).indexOf(id) >= 0; }));
      });
    });
  })
  /* --- Bereichssperre beim Versiegeln (Altschlüssel bestehend, nicht aktualisierbar) -> löschen + neu anlegen --- */
  .then(function () {
    var mt = new MockTransport(), lk = legacyKey("gruppe5");
    mt.store[lk] = { value: JSON.stringify({ schemaVersion: 1, gruppenbezeichnung: "gruppe5", clients: [client("l1", "Alt")] }), version: 5 };
    mt.spaceLocked = {}; mt.spaceLocked[lk] = true;
    var s = mk(mt);
    return s.load().then(function (m) { return addTo(s, m, client("l2", "Neu")); }).then(function (r) {
      ok("Bereichssperre am Altschlüssel: Migration + Versiegelung trotzdem", r.ok && B.isGuard(mt.val(lk)));
    });
  })

  /* --- Pflicht: Altformat lesbar, Migration beim ersten Speichern, Platzhalter --- */
  .then(function () {
    var mt = new MockTransport(), lk = legacyKey("gruppe5");
    var old = { schemaVersion: 1, gruppenbezeichnung: "gruppe5", lastModified: "2026-10-01T08:00:00Z",
                config: { entscheidungsGrenze: 21 }, printCols: { name: true }, mailTemplate: { to: "a@b.de" },
                clients: [client("l1", "Lea"), client("l2", "Leo")] };
    mt.store[lk] = { value: JSON.stringify(old), version: 17 };
    var s = mk(mt), w0;
    return s.load().then(function (m) {
      ok("Altformat: wird gelesen", ids(m).join() === "l1,l2" && m.config.entscheidungsGrenze === 21 && !!s.legacy);
      ok("Altformat: beim Laden noch NICHT versiegelt (alte Tabs laufen bis zum ersten Speichern)", !B.isGuard(mt.val(lk)) && !mt.store[manKey()]);
      w0 = mt.writes;
      return addTo(s, m, client("l3", "Lou"));
    }).then(function (r) {
      ok("Migration: erster Save schreibt neues Format", r.ok && r.migrated && mt.val(manKey()).gen === 1 && mt.val(manKey()).schema === 2);
      var g = mt.val(lk);
      ok("Migration: Altschlüssel trägt unlesbaren Platzhalter", B.isGuard(g) && typeof g.clients === "string");
      ok("Migration: Altstand bleibt als Historie (Sicherung) erhalten", chunkKeys(mt).some(function (k) { return /\.c-1-alt/.test(k); }));
      return mk(mt).load();
    }).then(function (m) {
      ok("Migration: Neuladen liest neues Format inkl. Einstellungen", ids(m).join() === "l1,l2,l3" && m.mailTemplate.to === "a@b.de");
    });
  })
  /* --- Pflicht: alte Version scheitert am Platzhalter (exakte Lese-/Schreiblogik von Format 1) --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var g = mt.val(legacyKey("gruppe5")), threw = false;
    // Format 1: state = j.value; danach renderTable -> sortClients(st.clients) -> cs.slice(); Aufnahme -> state.clients.push
    try { var st = g; st.clients.slice().sort(); st.clients.push({}); } catch (e) { threw = true; }
    ok("Altversion: Platzhalter führt zu Laufzeitfehler statt leerem Modell", threw);
    ok("Altversion: Platzhalter zeigt Hinweis zum Neuladen", /neu laden/i.test(g.belegiosGuard));
  })
  /* --- Altversion speichert NACH der Migration über den Platzhalter (Tab vor Versiegelung geöffnet) --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var lk = legacyKey("gruppe5"), cur = mt.store[lk];
    // alter Tab: PUT version+1 mit seinem (alten) Stand
    mt.store[lk] = { value: JSON.stringify({ schemaVersion: 1, clients: [client("alt1", "Alter Tab")] }), version: cur.version + 1 };
    var s = mk(mt);
    return s.load().then(function (m) {
      ok("Altversion-Schreibvorgang: neues Format bleibt maßgeblich", ids(m).join() === "a,b");
      return s.pending;
    }).then(function () {
      ok("Altversion-Schreibvorgang: wird beim Laden gesichert + neu versiegelt + Hinweis", B.isGuard(mt.val(lk)) && !!s.warning &&
         chunkKeys(mt).some(function (k) { return /\.c-\d+-alt/.test(k); }));
    });
  })
  /* --- Altversion speichert, während die neue noch im Altformat ist -> Konflikt-Replay statt Überschreiben --- */
  .then(function () {
    var mt = new MockTransport(), lk = legacyKey("gruppe5");
    mt.store[lk] = { value: JSON.stringify({ schemaVersion: 1, clients: [client("l1", "Lea")] }), version: 3 };
    var s = mk(mt);
    return s.load().then(function (m) {
      mt.store[lk] = { value: JSON.stringify({ schemaVersion: 1, clients: [client("l1", "Lea"), client("lx", "vom alten Tab")] }), version: 4 };
      return addTo(s, m, client("n1", "Neu"));
    }).then(function (r) {
      ok("Altformat-Konflikt: Änderung des alten Tabs bleibt erhalten", r.ok && r.merged && ids(r.model).join() === "l1,lx,n1");
    });
  })
  /* --- Neuere Version (Schema > 2) -> Ladefehler statt Überschreiben --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var man = mt.val(manKey()); man.schema = 3; mt.store[manKey()].value = JSON.stringify(man);
    var s = mk(mt);
    return s.load().then(function () { ok("Schema 3 -> Ladefehler", false); }, function (e) { ok("neuere Version -> Ladefehler + readOnly", s.readOnly && e.newer); });
  })
  /* --- Manifest fehlt, Datensätze vorhanden -> nie leer --- */
  .then(function () { return seeded(); }).then(function (mt) {
    delete mt.store[manKey()]; delete mt.store[legacyKey("gruppe5")];
    var s = mk(mt);
    return s.load().then(function (m) {
      ok("Manifest weg: Rückfall auf neuesten Satz, schreibgeschützt (nicht leer)", s.recovered && s.readOnly && ids(m).join() === "a,b");
      return s.describeSets();
    }).then(function (d) {
      var top = d.rows.filter(function (r) { return r.ok; })[0];
      return s.restoreFrom(top.gen, top.token, top.count).then(function (r) {
        ok("Manifest weg: Wiederherstellung schreibt Generation über allen Sätzen", r.ok && r.gen > top.gen);
      });
    });
  })

  /* --- Historie: GC hält 10 Generationen, entfernt ältere, nie neuere --- */
  .then(function () {
    var mt = new MockTransport(), s = mk(mt), K = new B.Keys(prefix("gruppe5"));
    var chain = s.load();
    for (var i = 0; i < 14; i++) (function (i) { chain = chain.then(function (m) { m = m.model || m; return addTo(s, m, client("g" + i, "G" + i)); }); })(i);
    return chain.then(function () {
      mt.store[K.chunk(99, 0, "inflight")] = { value: "\"x\"", version: 1 };
      var F = mk(mt);
      return F.load().then(function () { return F.pending; }).then(function () {
        var gens = {}; chunkKeys(mt).forEach(function (k) { gens[K.parseChunk(k).gen] = 1; });
        var g = Object.keys(gens).map(Number).sort(function (a, b) { return a - b; });
        ok("GC: hält die letzten 10 Generationen (5..14)", g[0] === 5 && g.indexOf(14) >= 0, JSON.stringify(g));
        ok("GC: lässt zukünftige Generation (in Arbeit) stehen", !!mt.store[K.chunk(99, 0, "inflight")]);
        ok("GC: Speichern löscht keine alten Generationen", s.gen === 14);
      });
    });
  })
  /* --- Kein GC nach Rückfall-Laden --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var man = mt.val(manKey()), K = new B.Keys(prefix("gruppe5"));
    delete mt.store[K.chunk(man.gen, 0, man.token)];
    var n0 = chunkKeys(mt).length, s = mk(mt);
    return s.load().then(function () { return s.pending; }).then(function () { ok("Rückfall-Laden: kein Aufräumlauf", chunkKeys(mt).length === n0); });
  })

  /* --- Pflicht: zwei Instanzen auf einer Seite -> getrennte Stores --- */
  .then(function () {
    var mt = new MockTransport();
    mt.store[legacyKey("gruppe5")] = { value: JSON.stringify({ schemaVersion: 1, clients: [client("g5", "Fünf")] }), version: 2 };
    mt.store[legacyKey("gruppe6")] = { value: JSON.stringify({ schemaVersion: 1, clients: [client("g6", "Sechs")] }), version: 2 };
    var s5 = mk(mt, "gruppe5"), s6 = mk(mt, "gruppe6");
    return Promise.all([s5.load(), s6.load()]).then(function (ms) {
      ok("2 Instanzen: getrennt geladen", ids(ms[0]).join() === "g5" && ids(ms[1]).join() === "g6");
      return addTo(s5, ms[0], client("g5b", "Fünf b")).then(function () { return addTo(s6, ms[1], client("g6b", "Sechs b")); })
        .then(function () { return addTo(s6, ms[1], client("g6c", "Sechs c")); });
    }).then(function () {
      ok("2 Instanzen: eigene Manifeste", mt.val(manKey("gruppe5")).gen === 1 && mt.val(manKey("gruppe6")).gen === 2);
      ok("2 Instanzen: beide Altschlüssel versiegelt", B.isGuard(mt.val(legacyKey("gruppe5"))) && B.isGuard(mt.val(legacyKey("gruppe6"))));
      return Promise.all([mk(mt, "gruppe5").load(), mk(mt, "gruppe6").load()]);
    }).then(function (ms) {
      ok("2 Instanzen: keine Vermischung", ids(ms[0]).join() === "g5,g5b" && ids(ms[1]).join() === "g6,g6b,g6c");
      var s5 = mk(mt, "gruppe5");
      return s5.load().then(function () { return s5.pending; }).then(function () { return s5.describeSets(); });
    }).then(function (d) {
      ok("2 Instanzen: Datenstände nur der eigenen Instanz", d.rows.every(function (r) { return r.ok; }) && d.rows.filter(function (r) { return !r.archived; }).length === 1);
    });
  })
  /* --- Instanzname, der Präfix einer anderen ist (gruppe5 vs gruppe5a) --- */
  .then(function () {
    var mt = new MockTransport(), a = mk(mt, "gruppe5"), b = mk(mt, "gruppe5a");
    return a.load().then(function (m) { return addTo(a, m, client("x", "x")); })
      .then(function () { return b.load(); }).then(function (m) {
        ok("Präfix-Kollision gruppe5/gruppe5a: kein Fremdzugriff", m.clients.length === 0 && !b.readOnly);
      });
  })

  /* --- Einstellungs-Delta (replaySetTop) übersteht Konflikt --- */
  .then(function () { return seeded(); }).then(function (mt) {
    var A = mk(mt), O = mk(mt), mA;
    return A.load().then(function (m) { mA = m; return O.load(); }).then(function (mo) { return addTo(O, mo, client("f", "Fremd")); }).then(function () {
      mA.printCols = { name: true, bt: false };
      return A.save(mA, rTop({ printCols: mA.printCols }));
    }).then(function (r) { ok("printCols-Delta: Konflikt-Merge behält Fremdklient", r.merged && ids(r.model).indexOf("f") >= 0 && r.model.printCols.bt === false); });
  });
};

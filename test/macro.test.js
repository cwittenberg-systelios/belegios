/* Das gerenderte Macro im jsdom: Laden, Migration, Ladefehler-Banner, sichtbare Speicherfehler
 * (auch printCols/mailTemplate), zwei Instanzen auf einer Seite, Admin-Datenstände, Inline-Selbsttest. */
"use strict";
var H = require("./helpers"), ok = H.ok, eq = H.eq, MockTransport = H.MockTransport, tick = H.tick;
var B = H.loadStore();

function client(id, name) {
  return { id: id, name: name, aufnahmedatum: "2026-10-01", kostenzusage_traeger: "PKV", kostenzusage_bis: "2027-01-31",
           kostenzusage_detail: "", verlaengerung_bis: null, verlaengerung_status: "keine", goae: false, jupsy: false,
           bt_verbal: "", bt_nonverbal: "", kein_ue_gruppe: false, entlassdatum: null };
}
function legacy(mt, inst, clients, extra) {
  var v = Object.assign({ schemaVersion: 1, gruppenbezeichnung: inst, lastModified: "2026-10-01T08:00:00Z", clients: clients }, extra || {});
  mt.store["belegungsplaner_4711_" + inst] = { value: JSON.stringify(v), version: 9 };
}
function env(mt, opts) {
  opts = opts || {};
  var e = H.browserEnv({ transport: mt, pages: opts.pages, admin: opts.admin, canEdit: opts.canEdit });
  e.window.print = function () {};
  e.window.requestAnimationFrame = function (f) { return setTimeout(f, 0); };
  return e;
}
function $(w, sel) { return w.document.querySelector(sel); }
function click(w, el) { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); }
function rows(w, inst) { return w.document.querySelectorAll("#bp-table-" + inst + " tbody tr[class*='bp-row-']").length; }
function bannerText(w, inst) { var el = $(w, "#bp-persist-" + inst); return el && el.style.display !== "none" ? el.textContent : ""; }

module.exports = function () {
  H.group("Macro (jsdom)");
  return Promise.resolve()

  /* --- Altformat laden + erste Änderung migriert + Build sichtbar --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna"), client("b", "Bert")], { config: { entscheidungsGrenze: 17 } });
    var e = env(mt), w = e.window;
    return tick().then(function () {
      var bp = w._bp.gruppe5;
      ok("Altformat: Macro lädt beide Klient:innen", bp.getState().clients.length === 2 && rows(w, "gruppe5") === 2);
      ok("Altformat: schreibbar, kein Fehlerbanner", bp.canEdit() && bannerText(w, "gruppe5") === "");
      ok("Build-Version sichtbar im Fuß", /Build 2\.0\.0/.test($(w, "#bp-build-gruppe5").textContent));
      ok("Build-Version in der Konsole", e.logs.some(function (l) { return /Build 2\.0\.0/.test(l); }));
      ok("Altschlüssel beim reinen Anzeigen unangetastet", mt.writes === 0);
      var st = bp.getState(); st.clients[0].bt_verbal = "Frau X";
      return bp.saveState(st, { replay: function (b) { b.clients[0].bt_verbal = "Frau X"; return b; } });
    }).then(function () {
      return tick();
    }).then(function () {
      var man = mt.val("belegios_4711_gruppe5.m");
      ok("Migration über das Macro: Manifest Format 2 mit Build", man && man.schema === 2 && /2\.0\.0/.test(man.build));
      ok("Migration über das Macro: Altschlüssel versiegelt", B.isGuard(mt.val("belegungsplaner_4711_gruppe5")));
      ok("Migration: gespeicherter Stand trägt schemaVersion 2", JSON.parse(JSON.parse(mt.store[Object.keys(mt.store).filter(function (k) { return /\.c-1-(?!alt)/.test(k); })[0]].value)).schemaVersion === 2);
    });
  })

  /* --- Format-1-Macro (main) gegen versiegelten Stand: scheitert, speichert nichts --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna")]);
    var e = env(mt), w = e.window;
    return tick().then(function () {
      var bp = w._bp.gruppe5, st = bp.getState(); st.clients[0].name = "Anna M.";
      return bp.saveState(st, { replay: function (b) { b.clients[0].name = "Anna M."; return b; } });
    }).then(function () {
      var fs = require("fs"), path = require("path");
      var oldSrc = fs.readFileSync(path.join(__dirname, "fixtures", "belegios-v1.vm"), "utf8");
      var e1 = H.browserEnv({ transport: mt, vmSrc: oldSrc }), w1 = e1.window, w0 = mt.writes;
      return tick().then(function () {
        var st1 = w1.document.querySelector("#bp-status-gruppe5").textContent;
        ok("Format-1-Tab: Laden scheitert sichtbar statt leer", /Fehler/.test(st1) && rows(w1, "gruppe5") === 0, st1);
        // Versuch einer Neuaufnahme im alten Tab: darf den Platzhalter nicht ersetzen
        var addBtn = w1.document.querySelector('[data-bp-action="add"]');
        ok("Format-1-Tab: keine Bearbeiten-Knöpfe nach Ladefehler", !addBtn);
        ok("Format-1-Tab: kein Schreibzugriff", mt.writes === w0 && B.isGuard(mt.val("belegungsplaner_4711_gruppe5")));
      });
    });
  })

  /* --- Format-1-Tab war VOR der Migration offen und speichert danach: 409 -> Replay auf Platzhalter scheitert --- */
  .then(function () {
    var fs = require("fs"), path = require("path");
    var oldSrc = fs.readFileSync(path.join(__dirname, "fixtures", "belegios-v1.vm"), "utf8");
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna"), client("b", "Bert")]);
    var eOld = H.browserEnv({ transport: mt, vmSrc: oldSrc }), wOld = eOld.window;
    var eNew, wNew;
    return tick().then(function () {
      ok("Format-1-Tab (vor Migration geöffnet) lädt normal", wOld._bp.gruppe5.getState().clients.length === 2);
      eNew = env(mt); wNew = eNew.window;
      return tick();
    }).then(function () {
      var bp = wNew._bp.gruppe5, st = bp.getState(); st.clients[0].bt_verbal = "Neu";
      return bp.saveState(st, { replay: function (b) { b.clients[0].bt_verbal = "Neu"; return b; } });
    }).then(function () {
      var bpo = wOld._bp.gruppe5, results = [];
      var st = bpo.getState();
      function attempt(fn, replay) { return bpo.saveState(fn(st), { replay: replay }).then(function () { results.push("ok"); }, function () { results.push("err"); }); }
      return attempt(function (s) { s.clients.push(client("z", "Zoe")); return s; },
                     function (b) { b.clients.push(client("z", "Zoe")); return b; })
        .then(function () { return attempt(function (s) { s.clients[0].name = "X"; return s; },
                     function (b) { var i = b.clients.findIndex(function (c) { return c.id === "a"; }); b.clients[i].name = "X"; return b; }); })
        .then(function () { return results; });
    }).then(function (results) {
      // Bekannte Grenze: erster Versuch scheitert (409 -> Replay auf Platzhalter wirft), der zweite
      // überschreibt den Platzhalter (Version wurde beim ersten Versuch übernommen).
      eq("Format-1-Tab: erster Speicherversuch nach Migration scheitert", results[0], "err");
      ok("Format-1-Tab: neue Daten bleiben unberührt", mt.val("belegios_4711_gruppe5.m").gen === 1);
      wNew.document.dispatchEvent(new wNew.Event("visibilitychange"));   // Polling im neuen Tab
      return tick();
    }).then(function () {
      ok("Polling: überschriebener Platzhalter wird gesichert + neu versiegelt", B.isGuard(mt.val("belegungsplaner_4711_gruppe5")) &&
         Object.keys(mt.store).some(function (k) { return /^belegios_4711_gruppe5\.c-1-alt/.test(k); }));
      ok("Polling: Hinweis auf parallelen Altversion-Stand sichtbar", /älteren Version|aeltere Version/i.test(bannerText(wNew, "gruppe5")), bannerText(wNew, "gruppe5"));
      return new B.Store(mt, { prefix: "belegios_4711_gruppe5", legacyKey: "belegungsplaner_4711_gruppe5" }).describeSets();
    }).then(function (d) {
      ok("Datenstände: Sicherung des Altversion-Stands wiederherstellbar gelistet", d.rows.some(function (r) { return r.archived && r.ok && r.clients >= 2; }));
    });
  })

  /* --- Leser ohne Bearbeitungsrecht: lädt, schreibt nichts (auch keine Wartung) --- */
  .then(function () {
    var mt = new MockTransport(), s = new B.Store(mt, { prefix: "belegios_4711_gruppe5", legacyKey: "belegungsplaner_4711_gruppe5" });
    return s.load().then(function (m) { m.clients.push(client("a", "Anna")); return s.save(m, null); }).then(function () {
      delete mt.store["belegungsplaner_4711_gruppe5"];   // Platzhalter fehlt -> würde mit Schreibrecht nachgezogen
      var w0 = mt.writes, e = env(mt, { canEdit: false }), w = e.window;
      return tick().then(function () {
        ok("Leser: Daten sichtbar, keine Bearbeiten-Knöpfe", rows(w, "gruppe5") === 1 && !$(w, '#bp-root-gruppe5 [data-bp-action="edit"]'));
        ok("Leser: kein Schreibzugriff (kein Versiegeln/GC)", mt.writes === w0);
      });
    });
  })

  /* --- Ladefehler: deutlicher Hinweis, schreibgeschützt, keine Tabelle aus leerem Modell --- */
  .then(function () {
    var mt = new MockTransport();
    mt.store["belegios_4711_gruppe5.m"] = { value: JSON.stringify({ gen: 4, count: 1, token: "weg" }), version: 4 };
    var e = env(mt), w = e.window;
    return tick().then(function () {
      var bp = w._bp.gruppe5;
      ok("Ladefehler: Banner 'schreibgeschützt' sichtbar", /schreibgeschützt/.test(bannerText(w, "gruppe5")));
      ok("Ladefehler: keine Tabelle aus Ersatzmodell", rows(w, "gruppe5") === 0 && !!$(w, "#bp-table-gruppe5 .bp-load-failed"));
      ok("Ladefehler: canEdit false, kein Aufnahme-Knopf", !bp.canEdit() && !$(w, '#bp-root-gruppe5 [data-bp-action="add"]'));
      return bp.saveState({ clients: [] }, {}).then(function () { return null; }, function (er) { return er; });
    }).then(function (er) {
      ok("Ladefehler: saveState verweigert, nichts geschrieben", !!er && mt.writes === 0);
    });
  })

  /* --- Rückfall-Stand: angezeigt, schreibgeschützt, Admin stellt über Datenstände wieder her --- */
  .then(function () {
    var mt = new MockTransport(), s = new B.Store(mt, { prefix: "belegios_4711_gruppe5", legacyKey: "belegungsplaner_4711_gruppe5" });
    return s.load().then(function (m) { m.clients.push(client("a", "Anna")); return s.save(m, null); })
      .then(function (r) { r.model.clients.push(client("b", "Bert")); return s.save(r.model, null); })
      .then(function () {
        var man = mt.val("belegios_4711_gruppe5.m");
        delete mt.store["belegios_4711_gruppe5.c-" + man.gen + "-" + man.token + "-0"];
        var e = env(mt, { admin: true }), w = e.window;
        return tick().then(function () {
          var bp = w._bp.gruppe5;
          ok("Rückfall: älterer Stand angezeigt", rows(w, "gruppe5") === 1);
          ok("Rückfall: Banner + schreibgeschützt", /älterer Datenstand/.test(bannerText(w, "gruppe5")) && !bp.canEdit());
          ok("Admin: Selbsttest-Panel mit Datenstände-Knopf sichtbar", $(w, "#bp-selftest-gruppe5").style.display === "block" &&
             !!$(w, '#bp-selftest-gruppe5 [data-bp-action="admin-datenstaende"]'));
          click(w, $(w, '#bp-selftest-gruppe5 [data-bp-action="admin-datenstaende"]'));
          return tick();
        }).then(function () {
          var btns = w.document.querySelectorAll('#bp-modal-gruppe5 [data-bp-action="admin-restore"]');
          ok("Datenstände-Dialog listet wiederherstellbaren Stand", btns.length >= 1 && /unlesbar/.test($(w, "#bp-modal-gruppe5").textContent));
          click(w, btns[0]);
          return tick(5);
        }).then(function () {
          var yes = w.document.querySelector("#bp-cy"); click(w, yes);
          return tick();
        }).then(function () {
          var bp = w._bp.gruppe5;
          ok("Wiederherstellung: schreibbar, Banner weg, neue Generation", bp.canEdit() && bannerText(w, "gruppe5") === "" && mt.val("belegios_4711_gruppe5.m").gen === 3);
        });
      });
  })

  /* --- Speicherfehler sichtbar: Klientenänderung, printCols, mailTemplate --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna")]);
    var e = env(mt), w = e.window;
    return tick().then(function () {
      mt.failPutMatching = /^belegios_/;
      click(w, $(w, '#bp-root-gruppe5 [data-bp-action="edit"]'));
      $(w, "#bp-e-name") && ($(w, "#bp-e-name").value = "Anna Neu");
      var save = $(w, '[data-bp-action="save-edit"]');
      if (save) click(w, save);
      return tick();
    }).then(function () {
      ok("Speicherfehler (Edit): stehender Hinweis 'NICHT gespeichert'", /NICHT gespeichert/.test(bannerText(w, "gruppe5")));
      ok("Speicherfehler (Edit): Anzeige zurückgesetzt", w._bp.gruppe5.getState().clients[0].name === "Anna");
      click(w, $(w, '[data-bp-action="dismiss-persist"]'));
      click(w, $(w, '#bp-root-gruppe5 [data-bp-action="print"]'));
      var cp = $(w, '[data-bp-action="confirm-print"]'); if (cp) click(w, cp);
      return tick();
    }).then(function () {
      ok("printCols-Fehler sichtbar (Status + Banner)", /Spaltenauswahl NICHT gespeichert/.test($(w, "#bp-status-gruppe5").textContent) && /NICHT gespeichert/.test(bannerText(w, "gruppe5")));
      click(w, $(w, '[data-bp-action="dismiss-persist"]'));
      click(w, $(w, '#bp-root-gruppe5 [data-bp-action="versand"]'));
      var to = $(w, "#bp-v-to"); if (to) to.value = "team@example.org";
      var vm = $(w, '[data-bp-action="versand-mail"]'); if (vm) click(w, vm);
      return tick();
    }).then(function () {
      ok("mailTemplate-Fehler sichtbar", /Versand-Vorlage NICHT gespeichert/.test($(w, "#bp-status-gruppe5").textContent));
      mt.failPutMatching = null;
      ok("nach Fehlern: Altschlüssel unverändert (keine Teilmigration)", mt.val("belegungsplaner_4711_gruppe5").clients[0].name === "Anna" && !mt.store["belegios_4711_gruppe5.m"]);
    });
  })

  /* --- Gescheiterter Save wird nicht vom nächsten Save mitgeschleppt --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna"), client("b", "Bert")]);
    var e = env(mt), w = e.window, bp;
    return tick().then(function () {
      bp = w._bp.gruppe5;
      var st = bp.getState();
      mt.failPutMatching = /^belegios_/;
      st.clients[0].bt_verbal = "FEHLER";
      var p1 = bp.saveState(st, { replay: function (b) { b.clients[0].bt_verbal = "FEHLER"; return b; } }).catch(function () {});
      return p1.then(function () {
        mt.failPutMatching = null;
        var st2 = bp.getState(); st2.clients[1].bt_verbal = "OK";   // Aufrufer hätte gerollbackt; hier absichtlich NICHT
        return bp.saveState(st2, { replay: function (b) { b.clients[1].bt_verbal = "OK"; return b; } });
      });
    }).then(function () {
      var s = new B.Store(mt, { prefix: "belegios_4711_gruppe5", legacyKey: "belegungsplaner_4711_gruppe5" });
      return s.load();
    }).then(function (m) {
      ok("Rebase: nur eigenes Delta gespeichert, gescheiterte Änderung nicht mitgeschleppt", m.clients[0].bt_verbal === "" && m.clients[1].bt_verbal === "OK");
    });
  })

  /* --- Zwei Instanzen auf einer Seite --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna")]);
    legacy(mt, "gruppe6", [client("x", "Xaver"), client("y", "Yvonne")]);
    var e = env(mt, { pages: [{ inst: "gruppe5" }, { inst: "gruppe6" }] }), w = e.window;
    return tick().then(function () {
      ok("2 Instanzen: beide geladen, getrennt gerendert", rows(w, "gruppe5") === 1 && rows(w, "gruppe6") === 2);
      var b6 = w._bp.gruppe6, st = b6.getState(); st.clients[0].bt_verbal = "Z";
      return b6.saveState(st, { replay: function (b) { b.clients[0].bt_verbal = "Z"; return b; } });
    }).then(function () {
      ok("2 Instanzen: nur gruppe6 migriert", !!mt.store["belegios_4711_gruppe6.m"] && !mt.store["belegios_4711_gruppe5.m"] &&
         !B.isGuard(mt.val("belegungsplaner_4711_gruppe5")) && B.isGuard(mt.val("belegungsplaner_4711_gruppe6")));
      ok("2 Instanzen: je ein Build-Fuß", /Build/.test($(w, "#bp-build-gruppe5").textContent) && /Build/.test($(w, "#bp-build-gruppe6").textContent));
    });
  })

  /* --- Update-Hinweis (Polling) bei fremder Generation --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna")]);
    var e = env(mt), w = e.window, s2;
    return tick().then(function () {
      s2 = new B.Store(mt, { prefix: "belegios_4711_gruppe5", legacyKey: "belegungsplaner_4711_gruppe5" });
      return s2.load();
    }).then(function (m) { m.clients.push(client("n", "Neu")); return s2.save(m, null); }).then(function () {
      w.document.dispatchEvent(new w.Event("visibilitychange"));
      return tick();
    }).then(function () {
      var ub = $(w, "#bp-update-gruppe5");
      ok("Polling: fremde Speicherung (inkl. Migration) zeigt Update-Hinweis", ub && ub.style.display === "flex");
    });
  })

  /* --- Inline-Selbsttest bleibt grün und schreibt nichts --- */
  .then(function () {
    var mt = new MockTransport();
    legacy(mt, "gruppe5", [client("a", "Anna")]);
    var e = env(mt, { admin: true }), w = e.window;
    return tick().then(function () {
      var w0 = mt.writes;
      click(w, $(w, "#bp-selftest-run-gruppe5"));
      return tick().then(function () {
        var res = $(w, "#bp-selftest-result-gruppe5").textContent;
        var m = /Selbsttest: (\d+)\/(\d+)/.exec(res);
        ok("Inline-Selbsttest läuft", !!m, res.slice(0, 120));
        var fails = Array.prototype.slice.call(w.document.querySelectorAll("#bp-selftest-result-gruppe5 li"))
          .filter(function (li) { return /^✗/.test(li.textContent.trim()); }).map(function (li) { return li.textContent.trim().slice(0, 100); });
        eq("Inline-Selbsttest: alle grün", fails, []);
        ok("Inline-Selbsttest: kein echter Schreibzugriff", mt.writes === w0);
        if (m) console.log("  (Inline-Selbsttest " + m[1] + "/" + m[2] + ")");
      });
    });
  });
};

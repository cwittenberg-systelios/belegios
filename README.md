# belegios – Belegungsplaner (Confluence User Macro)

`belegios.vm` ist ein Confluence-Server-User-Macro (Velocity-Template mit Inline-HTML/CSS/JS).
Die Daten liegen als Content Properties der Seite, **je Macro-Instanz** (`Gruppenbezeichnung`) getrennt.

## Persistenz (ab Build 2.0.0, Datenformat 2)

| Schlüssel | Inhalt |
|---|---|
| `belegios_<pageId>_<instId>.m` (`.m.2`, `.m.3` …) | Manifest `{gen, count, token, schema, build, ts}`. Nach einem Bereichswechsel zieht es auf den nächsten Schlüssel um, maßgeblich ist die höchste Generation. |
| `belegios_<pageId>_<instId>.c-<gen>-<token>-<i>` | Daten-Chunks (Copy-on-Write, ≤ 24 kB). Die letzten 10 Generationen bleiben als Historie erhalten. |
| `belegungsplaner_<pageId>_<instId>` | Altschlüssel (Format 1). Wird gelesen, beim ersten Speichern migriert und dann mit einem **unlesbaren Platzhalter** versiegelt, damit alte offene Tabs scheitern statt zu überschreiben. |

- Wenn Laden scheitert (fehlender Chunk, kaputtes JSON, Lesefehler, neueres Format), erscheint ein deutlicher Hinweis und das Macro ist **schreibgeschützt**. Es arbeitet nie still mit einem leeren Stand.
- Wenn der neueste Stand unvollständig ist, wird der letzte lesbare ältere Stand angezeigt, aber nur schreibgeschützt.
- Speichern: Bei 409 wird der Stand frisch geladen und nur das eigene Delta neu angewendet (≤ 2×). Bei 5xx oder Netzfehler wird das Manifest nachgelesen; je nach Ergebnis ist das ein Erfolg, ein Konflikt oder ein Umzug des Manifests.
- Jeder Speicherfehler wird angezeigt, auch bei Druck-Spaltenauswahl und Versand-Vorlage.
- **Admin** (Gruppen `confluence-administrators`, `confluenceAdmin`): Die Maintainer-Werkzeuge unter der Tabelle enthalten **Datenstände**. Dort werden alle Generationen aufgelistet, und ein älterer Stand lässt sich als neue Generation wiederherstellen. Dabei wird nichts gelöscht.
- Die Build-Version steht im Fuß und in der Konsole. Bei jeder Änderung `BUILD_VERSION` in `belegios.vm` hochzählen.

## Tests

```sh
npm install
npm test
```

Testumfang:
- Store mit Mock-Transport: Pflichtfälle der Übergabe §3.2, Altformat-Migration, Platzhalter, zwei Instanzen.
- Velocity: Lint auf neue `#`/`$`-Muster, Rendern mit velocityjs, Syntaxprüfung des gerenderten Skripts.
- Gerendertes Macro im jsdom, inklusive des eingebauten Selbsttests.

`test/fixtures/belegios-v1.vm` ist der Stand vor der Umstellung (Format 1). Damit wird geprüft, dass eine alte Version am Platzhalter scheitert.

## Deploy-Reihenfolge

1. `npm test` muss grün sein.
2. Den Macro-Code in *Allgemeine Konfiguration → Benutzermakros → Belegungsplaner* durch `belegios.vm` ersetzen. Es ist ein Inline-Makro, ein Cache-Bust ist also nicht nötig.
3. Eine betroffene Seite öffnen und den Fuß prüfen: „Build 2.0.0 · Datenformat 2“. Zunächst wird nur gelesen; der Altschlüssel bleibt unverändert, bis jemand speichert.
4. **Alle Nutzer:innen die Seiten mit dem Belegungsplaner neu laden lassen** (Strg+F5), insbesondere lange offene Tabs.
5. Danach ist das neue Format „scharf“: Beim ersten Speichern einer Instanz wird migriert und der Altschlüssel versiegelt. Ein alter Tab bricht dann mit einem Fehler ab, statt zu überschreiben.
6. Nachkontrolle als Admin: Unter *Datenstände* je Instanz prüfen, ob die aktuelle Generation lesbar ist und die Anzahl der Klient:innen stimmt. Zusätzlich den *Selbsttest* ausführen.

Rückfall auf Build 1.x ist **nach** der ersten Migration nicht vorgesehen: Die alte Version liest nur den Platzhalter. Ein Notfall-Export ist über *Datenstände* oder das Property-Listing möglich.

## Seitenumzug

Die Seiten sind noch nicht verschoben. Falls doch, kann Confluence bestehende Properties nicht mehr aktualisieren (`Can't add an owner from another space`, HTTP 500). Der Store zieht das Manifest dann selbst auf `.m.2` usw. um. Den Altschlüssel löscht er und legt ihn neu an.

# Projektkontext: ioBroker.lox2hue

ioBroker-Adapter (CommonJS, Node.js `>= 22`), der Loxone-Lichtsteuerungs-Stimmungen
(`LightControllerV2` via `loxone.0`) auf Philips-Hue-Lampen (`hue.0` + direkte
Hue-Bridge-HTTPS-Aufrufe) spiegelt und statische Stimmungen als CLIP-v2-Szenen
auf der Bridge cached, damit alle Lampen eines Raums gleichzeitig schalten.

## Modulstruktur

- `main.js`: Adapter-Lifecycle (`utils.Adapter`), State-Subscriptions (`activeMoodsNum`,
  Lampen-Outputs `.rgb`/`.position`/`.active`), Watchdog, Echo-Unterdrückung und
  CLIP-v2-Zonen-/Szenen-Orchestrierung (`"lox2hue: <block>"` pro Raum, Schema v2 in `lox2hue.0.cache.scenes`).
- `lib/colorMath.js`: Reine Farbmatrix- und Farbtemperatur-Berechnungen (`rgbToXy`, `rgbToMired`).
- `lib/commandLogic.js`: Reine Kommandologik ohne ioBroker-Abhängigkeiten (`parseLoxoneRgb`,
  `computeRawCommand`, `commandToClipV2Action`, `commandSignature`, `snapshotFingerprint`).
- `lib/sceneStateMachine.js`: Reine Zustandsmaschine ohne ioBroker-Abhängigkeiten für
  Stimmungswechsel, Dynamic-Erkennung, eindeutige Szenennamen (`buildBridgeSceneName`) und
  Echo-Unterdrückung nach Bridge-Recalls (`shouldSuppressEcho`).
- `test/unit.js` & `test/package.js`: Mocha-Testsuiten.

## Kritische Invarianten (nicht verletzen)

1. **Loxone-`.rgb`-Format ist `0–255`:** `iobroker.loxone` schreibt `.rgb` bereits als
   `0–255`-Ganzzahlen (nicht `0–100`). Niemals nochmals mit `2.55` multiplizieren.
   Standardwert für `rgbBrightnessFactor` in `io-package.json` ist `1`.
2. **Hue Bridge CLIP v2 (`apiversion >= 1.78`, Header `hue-application-key`):**
   - Jede `scene` erfordert eine `group` (`room` oder `zone`).
   - Eine `zone` akzeptiert unter `children` nur `{ rid, rtype: 'light' }` (kein `'device'`).
   - CLIP v2 verlangt bei `POST /resource/scene`, dass `actions` **alle** Lichter der
     referenzierten `group` abdecken (`Light action targets not matching lights in referenced group`).
     Daher verwaltet `lox2hue` je Loxone-Block eine eigene Cache-Zone (`lox2hue: <block>`).
   - `dimming.brightness` muss im Bereich `0..100` bleiben; `color_temperature.mirek` wird
     gegen `mirek_schema` (`mirekMin..mirekMax`, Fallback `153..500`) geklemmt.
   - Schaltsteckdosen ohne `dimming`-Capability dürfen in Szenen-`actions` nur `{ on: { on } }`
     erhalten.
   - Szenen-Recall erfolgt per `PUT /clip/v2/resource/scene/{id}` mit
     `{ recall: { action: 'active', duration: fadeMs } }` (`duration` in Millisekunden).
   - Legacy-Aufräumung darf über die v1-API ausschließlich Szenen mit `type === 'LightScene'`
     und Präfix `lx_` löschen; CLIP-v2-Szenen erscheinen in v1 als `GroupScene`.
3. **Loxone-Race-Condition & Dynamic-Erkennung:** Loxone aktualisiert Lampen-Outputs oft
   wenige Millisekunden *vor* `.activeMoodsNum`. Eine statische Stimmung darf daher nie am
   Alter der vorherigen Stimmung gemessen werden, sondern erst nach mehreren zeitlich getrennten
   Änderungswellen (`minDynamicWaves`) innerhalb derselben unveränderten Stimmung über
   `dynamicGiveUpMs` hinaus (`lib/sceneStateMachine.js`).
4. **Explizite `0`-Werte respektieren:** `onFadeMs = 0` und `offFadeMs = 0` mit `??` statt `||`
   behandeln (`0 ms` darf nicht auf `700 ms` zurückfallen). Bei `watchdogIntervalMin <= 0`
   keinen Intervall-Timer starten.

## Entwicklung & Tests

- Pure Logik gehört in `lib/*.js` mit vollständigem JSDoc (werden per ESLint geprüft) und
  Unit-Tests in `test/unit.js`.
- Tests lokal ausführen: `npm test` (führt `test:package` und `test:unit` aus).
- Linting ausführen: `npm run lint` (`eslint .`).

## Produktiv-Deployment (Home-Lab)

- Produktive ioBroker-Instanz: Proxmox-Host `192.168.2.101`, LXC CT 100 unter
  `/opt/iobroker/node_modules/iobroker.lox2hue`.
- `iobroker`-CLI auf CT 100 immer als Benutzer `iobroker` ausführen (nicht als `root`):
  `su - iobroker -s /bin/bash -c "iobroker restart lox2hue.0"`.
- Nach manueller Datei-Synchronisation Besitzrechte auf `iobroker:iobroker` sicherstellen.

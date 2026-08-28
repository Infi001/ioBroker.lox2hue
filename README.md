# ioBroker.loxone2hue

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/flohero)

Spiegelt Loxone-Lichtsteuerungs-Stimmungen (LightControllerV2) auf Philips-Hue-Lampen. Loxone bleibt der Master — jede Änderung eines konfigurierten Loxone-Ausgangs wird sofort an die zugeordnete Hue-Lampe weitergegeben.

## Warum

Steuert man viele Hue-Lampen einzeln (ein Befehl pro Lampe), schalten sie sichtbar nacheinander statt gleichzeitig — die Hue-Bridge verarbeitet viele Einzelbefehle seriell. Eine echte Hue-Gruppen-/Szenen-Aktion dagegen ist ein Zigbee-Broadcast: alle betroffenen Lampen schalten zeitgleich.

Dieser Adapter lernt deshalb pro Raum (jeder mit `activeMoodsNum` erkannte Loxone-Lichtsteuerungsbaustein) und Stimmung die Zielwerte aller zugeordneten Lampen. Ist eine Stimmung einmal "eingeschwungen" (einige Sekunden ohne weitere Änderung), legt der Adapter dafür automatisch eine eigene, unsichtbare (`recycle`) Hue-Bridge-Szene an. Beim nächsten Aufruf derselben Stimmung genügt ein einziger Bridge-Aufruf statt N Einzelbefehlen.

Zwei Fälle werden automatisch — rein am Verhalten, nicht am Namen — von der Zwischenspeicherung ausgeschlossen:

- **Manueller Modus**: Loxone meldet `activeMoodsNum < 0`, wenn keine definierte Stimmung mehr exakt passt (z. B. nach manuellem Nachjustieren einer Lampe).
- **Dynamische Szenen** (z. B. "Party", "Wellness" mit ständig wechselnden Farben): kommt eine Stimmung länger als die konfigurierte Zeit nicht zur Ruhe, gilt sie als dynamisch und wird dauerhaft ausgeschlossen — Loxone steuert sie weiterhin live durch.

## Funktionen im Überblick

- **Szenen-Cache pro Raum** (siehe oben) für nahezu gleichzeitiges Schalten.
- **Mehrere Hue-Lampen an einem Loxone-Ausgang** werden korrekt unterstützt (z. B. zwei baugleiche Deckenspots an einem gemeinsamen Analogausgang) — alle bekommen das Kommando.
- **Getrennte Ein-/Ausschalt-Überblendzeit** (in Millisekunden), pro Adapter-Instanz einstellbar.
- **Farbtemperatur für White-Ambiance-Lampen**: ein fester Wert wird nur beim Einschalten gesetzt (nie beim bloßen Nachdimmen) — spätere manuelle Anpassungen in der Hue-App werden dadurch nicht ständig überschrieben. Kommt Farbinfo (RGB) vom Loxone-Ausgang, aber die Hue-Lampe kann nur Farbtemperatur (kein echtes RGB), wird die Farbe automatisch als Farbtemperatur angenähert.
- **Tradfri-Sonderfall**: Tradfri-Lampen reagieren unzuverlässig auf den normalen Hue-`.command`-Pfad und werden deshalb über eigene `.level`/`.ct`-States angesteuert (inkl. korrekter Kelvin- statt Mired-Umrechnung für die Farbtemperatur).
- **"Aus"-Wächter**: prüft periodisch, ob Lampen, die laut Loxone aus sein sollten, tatsächlich aus sind, und korrigiert sie bei Bedarf nach.
- **Automatisch aktuell gehaltene Loxone-Kontext-Anzeige** in der Konfiguration (zeigt Gruppe, Loxone-Name und erkannten Lampentyp direkt in der Zuordnungstabelle) plus manueller Aktualisieren-Button ohne Adapter-Neustart.
- **Zweisprachige Admin-Oberfläche** (Deutsch/Englisch, folgt der ioBroker-Admin-Spracheinstellung).

## Voraussetzungen

- Ein laufender `iobroker.hue`-Adapter (lokaler Bridge-Zugriff, `bridge`/`port` werden automatisch übernommen).
- Ein laufender `iobroker.loxone`-Adapter.
- Für die Szenen-Beschleunigung: Lampen, die zu einem Loxone-Lichtsteuerungsbaustein (LightControllerV2, mit `moodList`/`activeMoodsNum`) gehören. Einzelne Lampen ohne Stimmungs-Konzept funktionieren auch — dort greift nur die direkte Weiterleitung, keine Szenen-Beschleunigung.

## Installation

Noch kein offizieller Eintrag im ioBroker-Adapter-Katalog. Manuell installieren:

```bash
iobroker url https://github.com/Infi001/loxone2hue loxone2hue
```

(oder das Verzeichnis direkt nach `/opt/iobroker/node_modules/iobroker.loxone2hue` kopieren — **wichtig**: es muss eine echte Kopie sein, kein Symlink außerhalb dieses Pfads, siehe "Bekannte Stolperfallen" unten.)

Danach eine Instanz anlegen und wie unten beschrieben konfigurieren.

## Konfiguration

**Tab "Basic Settings"**

1. **Hue-Adapter-Instanz** und **Loxone-Adapter-Instanz** auswählen.
2. **Hue-Bridge-API-Token** eintragen (einmalig von Hand — steht in der Konfiguration der Hue-Adapter-Instanz im Feld "Nutzer", ist dort aber geschützt und lässt sich nicht automatisch übernehmen). Bridge-IP wird automatisch aus der Hue-Adapter-Konfiguration übernommen, falls das Feld leer bleibt.
3. Feineinstellungen (Ein-/Ausschalt-Überblendzeit, Sammel-Zeitfenster, Aus-Prüfintervall, Szenen-Ruhezeit, Farbtemperatur-Fixwert, Helligkeits-Obergrenze für Farblampen usw.) bei Bedarf anpassen — jede mit erklärendem Hilfetext, die Defaults passen für die meisten Installationen.

**Tab "Lamps"**

Tabelle mit drei Spalten füllen:

- **Loxone output**: den Lichtsteuerungs-Ausgangsblock selbst auswählen (z. B. "AI2"), nicht einen seiner Einzelwerte — der Adapter ermittelt automatisch anhand des erkannten Hue-Lampentyps, ob `.rgb`, `.position` oder `.active` genutzt wird.
- **Loxone context**: rein informativ, nicht editierbar — zeigt Gruppe, Loxone-Namen und erkannten Lampentyp. Die Gruppe wird direkt im ersten Textabschnitt (vor dem `::`) eingetragen/geändert. Nach dem Speichern per Button **"Refresh Loxone context"** sofort aktualisieren, ohne den Adapter neu zu starten.
- **Hue lamp/group**: die zugehörige Hue-Lampe oder -Gruppe.

## Bekannte Einschränkungen

- Lokale, funktionsfähige Version — noch kein offizieller ioBroker-Adapter-Katalog-Eintrag (kein `adapter-checker`-Durchlauf, keine automatisierten Tests/CI).
- Hue-Bridge-Zugriff erfolgt direkt (an `iobroker.hue` vorbei), da der Adapter keine Szenen-Verwaltung unterstützt. Zugangsdaten werden live aus dessen Konfiguration gelesen.
- Getestet mit Hue-Bridge-API v1 (CLIP v1, `apiversion` 1.78.0).
- RGB→Farbtemperatur-Annäherung für White-Ambiance-Lampen ist eine Näherung (McCamys Formel), keine exakte Umrechnung — gesättigte Farben (reines Rot/Grün/Blau) haben physikalisch keine sinnvolle Farbtemperatur, das Ergebnis wird auf einen plausiblen Bereich begrenzt.

## Lizenz

MIT

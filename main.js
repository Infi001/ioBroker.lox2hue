"use strict";

/*
 * ioBroker.lox2hue
 *
 * Spiegelt Loxone-Lichtsteuerungs-Stimmungen (LightControllerV2) auf Philips-Hue-Lampen.
 * Loxone bleibt der Master: jede Aenderung eines konfigurierten Loxone-Analogausgangs
 * (.rgb / .position / .active) wird sofort an die zugeordnete Hue-Lampe weitergegeben.
 *
 * Zusaetzlich lernt der Adapter pro Raum (Loxone-Lichtsteuerungsbaustein) und Stimmung
 * (activeMoodsNum) die Zielwerte aller zugeordneten Lampen. Sobald eine Stimmung einmal
 * "eingeschwungen" ist (8s lang keine Aenderung mehr), legt der Adapter dafuer eine eigene,
 * minimale Philips-Hue-Bridge-Szene an. Beim naechsten Aufruf derselben Stimmung wird nur
 * noch diese eine Szene abgerufen (ein einziger Bridge-Aufruf) statt N Einzelbefehle -
 * das behebt das nacheinander wirkende Schalten, das bei reiner Einzellampen-Steuerung
 * durch die Bridge/Zigbee-Verarbeitung entsteht.
 *
 * Zwei Faelle werden automatisch von der Zwischenspeicherung ausgeschlossen (rein am
 * Verhalten erkannt, nicht am Namen):
 *  - Manueller Modus: Loxone meldet activeMoodsNum < 0, wenn keine definierte Stimmung
 *    mehr exakt passt (z.B. weil eine Lampe von Hand nachjustiert wurde).
 *  - Dynamische Szenen (z.B. "Party"): kommt eine Stimmung laenger als
 *    dynamicGiveUpMs nicht zur Ruhe, gilt sie als dynamisch und wird dauerhaft
 *    ausgeschlossen.
 */

const utils = require("@iobroker/adapter-core");
const https = require("https");
const colorMath = require("./lib/colorMath");

class Loxone2Hue extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: "lox2hue" });

    this.deviceCapabilities = {}; // hueId -> { isGroup, cmdPrefix, isRGB, hasCT, isDimmer, isSwitch, loxoneSuffix, fullLoxoneId, bridgeId }
    this.roomGroups = {}; // roomKey -> { members: [{loxoneId,hueId}], activeMoodsId, currentMoodNum, currentMoodSince, settleTimer }
    this.sceneCache = {}; // roomKey -> { [moodNum]: { lights: {...}, bridgeSceneId } | { dynamic:true } }
    this.pendingChanges = new Map(); // hueId -> { loxoneId, hueId, val }
    this.loxoneToHue = new Map(); // fullLoxoneId -> Array<{ roomKey, hueId }> (mehrere Lampen pro Loxone-Ausgang moeglich)
    this.activeMoodsToRoom = new Map(); // activeMoodsId -> roomKey
    this.debounceTimer = null;
    this.cacheSaveTimer = null;
    this.watchdogInterval = null;
    this.stateExistsCache = new Map(); // id -> boolean, kleine Abkuerzung fuer wiederholte existsState-Abfragen
    this.lastKnownOn = new Map(); // hueId -> boolean, rein intern (kein Bridge-Roundtrip) fuer warAn()

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  // ---------------------------------------------------------------
  // Hilfsfunktionen: State-Existenz/-Zugriff mit kleinem Cache
  // ---------------------------------------------------------------
  async stateExists(id) {
    if (this.stateExistsCache.has(id)) {
      return this.stateExistsCache.get(id);
    }
    const obj = await this.getForeignObjectAsync(id);
    const exists = !!obj;
    this.stateExistsCache.set(id, exists);
    return exists;
  }

  async getForeignVal(id) {
    const s = await this.getForeignStateAsync(id);
    return s ? s.val : undefined;
  }

  // ---------------------------------------------------------------
  // Hue-Bridge direkt ansprechen (an der Adapter-Abstraktion vorbei) -
  // noetig fuer Szenen-Anlage/-Abruf, das kann iobroker.hue nicht.
  // ---------------------------------------------------------------
  async initHueBridge() {
    // Bridge-IP/-Port lassen sich bequem aus der hue-Adapter-Konfiguration uebernehmen
    // (nicht geschuetzt), als Vorbelegung/Fallback, falls in dieser Adapter-Instanz nicht
    // explizit gesetzt. Der API-Nutzer/Token ("user") ist bei iobroker.hue als
    // "protectedNative" markiert und daher per getForeignObject aus einem ANDEREN Adapter
    // NICHT lesbar (kommt als undefined zurueck, auch wenn die CLI/Admin-UI ihn zeigt) -
    // muss deshalb explizit in dieser Adapter-Konfiguration eingetragen werden.
    let fallbackHost, fallbackPort;
    try {
      const hueAdapterObj = await this.getForeignObjectAsync(
        `system.adapter.${this.config.hueInstance}`,
      );
      if (hueAdapterObj && hueAdapterObj.native) {
        fallbackHost = hueAdapterObj.native.bridge;
        fallbackPort = hueAdapterObj.native.port;
      }
    } catch {
      /* egal, dann eben nur die eigene Konfiguration */
    }

    this.hueBridgeHost = this.config.hueBridgeHost || fallbackHost;
    this.hueBridgePort = this.config.hueBridgePort || fallbackPort || 443;
    this.hueBridgeUser = this.config.hueBridgeUser;

    if (!this.hueBridgeHost) {
      throw new Error(
        'Keine Hue-Bridge-IP bekannt - bitte "Hue-Bridge-IP" in der Adapter-Konfiguration eintragen.',
      );
    }
    if (!this.hueBridgeUser) {
      throw new Error(
        `Kein Hue-Bridge-API-Token gesetzt - bitte "Hue-Bridge-API-Token" in der Adapter-Konfiguration eintragen ` +
          `(zu finden in der Konfiguration der ${
            this.config.hueInstance
          }-Instanz, Feld "Nutzer"/"user" - dort geschützt, ` +
          `muss hier einmalig manuell eingetragen werden).`,
      );
    }
  }

  hueBridgeRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          host: this.hueBridgeHost,
          port: this.hueBridgePort,
          path: `/api/${this.hueBridgeUser}${path}`,
          method: method,
          rejectUnauthorized: false,
          headers: data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {},
        },
        (res) => {
          let chunks = "";
          res.on("data", (c) => {
            chunks += c;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(chunks));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("Timeout")));
      if (data) {
        req.write(data);
      }
      req.end();
    });
  }

  // ---------------------------------------------------------------
  // Geraete-Erkennung (RGB / Dimmer / Schalter, Gruppe oder Einzellampe)
  // ---------------------------------------------------------------
  async detectDevice(hueId, loxoneBaseId) {
    if (this.deviceCapabilities[hueId]) {
      return this.deviceCapabilities[hueId];
    }

    const isGroup = await this.stateExists(`${hueId}.action.on`);
    const cmdPrefix = isGroup ? ".action" : "";

    const hasXY =
      (await this.stateExists(`${hueId + cmdPrefix}.xy`)) ||
      (await this.stateExists(`${hueId + cmdPrefix}.hue`));
    const hasCT = await this.stateExists(`${hueId + cmdPrefix}.ct`);
    const hasLevel = await this.stateExists(`${hueId + cmdPrefix}.level`);
    const hasOn = await this.stateExists(`${hueId + cmdPrefix}.on`);

    const type = {
      isGroup,
      cmdPrefix,
      isRGB: hasXY,
      hasCT,
      isDimmer: hasLevel,
      isSwitch: hasOn && !hasLevel,
      loxoneSuffix: "",
      fullLoxoneId: null,
      bridgeId: null,
    };

    if (type.isRGB) {
      type.loxoneSuffix = ".rgb";
    } else if (type.isDimmer) {
      // Weiss-Ambiance-Lampe (kein echtes RGB) - trotzdem ".rgb" abonnieren statt
      // ".position", WENN dieser Loxone-Ausgang selbst als echter Farbregler
      // konfiguriert ist (Loxone-Bausteintyp "ColorPickerV2"/"ColorPicker", nicht
      // "Dimmer") - dann kann die Farbabsicht als Farbtemperatur angenaehert werden
      // (siehe rgbZuMired() in berechneRohbefehl). Ein reiner "Dimmer"-Baustein hat
      // dagegen gar keine Farbinfo, da bleibt ".position" richtig. Nutzerwunsch 28.08.
      let loxoneIstFarbregler = false;
      if (loxoneBaseId) {
        const loxObj = await this.getForeignObjectAsync(loxoneBaseId);
        const controlType =
          loxObj &&
          loxObj.native &&
          loxObj.native.control &&
          loxObj.native.control.type;
        loxoneIstFarbregler = /color/i.test(controlType || "");
      }
      type.loxoneSuffix = loxoneIstFarbregler ? ".rgb" : ".position";
    } else {
      type.loxoneSuffix = ".active";
    }

    type.fullLoxoneId = loxoneBaseId ? loxoneBaseId + type.loxoneSuffix : null;

    const hueObj = await this.getForeignObjectAsync(hueId);
    type.bridgeId = hueObj && hueObj.native && hueObj.native.id;

    this.deviceCapabilities[hueId] = type;
    this.log.debug(
      `[INIT] ${hueId} (${isGroup ? "GRUPPE" : "LAMPE"}), Typ ${
        type.isRGB ? "RGB" : type.isDimmer ? "Dimmer" : "Switch"
      }, lauscht auf ${type.loxoneSuffix}`,
    );
    return type;
  }

  // ---------------------------------------------------------------
  // Prueft, ob eine Lampe VOR diesem Befehl an war - genutzt, um die feste
  // Farbtemperatur nur beim Aus->An-Uebergang zu setzen, nicht bei jeder
  // Helligkeitsaenderung waehrend sie schon an ist (sonst wuerde eine in der
  // Hue-App manuell gewaehlte Farbtemperatur bei jedem Dimmen wieder
  // ueberschrieben - Nutzerwunsch 28.08., damit die Hue-App fuer
  // Farbtemperatur weiterhin nutzbar bleibt, so wie es vor diesem Adapter
  // schon gehandhabt wurde).
  //
  // Bewusst NICHT der Live-Hue-State (".on"), sondern ein rein intern selbst
  // mitgefuehrter Zustand (lastKnownOn) - der Live-State braucht nach einem
  // Befehl teils sehr lange (mehrere Minuten, beobachtet am 27./28.08.), bis
  // die Bridge/der hue-Adapter ihn zurueckmeldet, waere also als Grundlage
  // fuer diese Entscheidung viel zu unzuverlaessig.
  warAn(hueId) {
    return this.lastKnownOn.get(hueId) === true;
  }

  // ---------------------------------------------------------------
  // Duenner Wrapper um berechneRohbefehl(): merkt sich nach jeder Berechnung,
  // ob die Lampe jetzt an oder aus sein wird (fuer warAn() bei der naechsten
  // Berechnung, siehe dort). Bleibt "async", auch wenn intern kein I/O mehr
  // steckt (warAn() ist jetzt rein intern/synchron) - so muessen die
  // Aufrufstellen nicht nochmal angepasst werden.
  // ---------------------------------------------------------------
  async computeCommand(inputVal, hueId) {
    const cmd = this.berechneRohbefehl(inputVal, hueId);
    if (cmd) {
      this.lastKnownOn.set(hueId, !cmd.isOff);
    }
    return cmd;
  }

  // rgbZuXy()/rgbZuMired() (reine Funktionen, kein Adapter-Zustand) sind fuer
  // Testbarkeit nach lib/colorMath.js ausgelagert (siehe test/unit.js), hier nur
  // duenne Wrapper darum, damit der restliche Code unveraendert this.rgbZuXy(...)
  // aufrufen kann.
  rgbZuXy(r, g, b) {
    return colorMath.rgbZuXy(r, g, b);
  }

  rgbZuMired(r, g, b) {
    return colorMath.rgbZuMired(r, g, b);
  }

  berechneRohbefehl(inputVal, hueId) {
    const type = this.deviceCapabilities[hueId];
    if (!type) {
      return null;
    }
    const isTradfri = /tradfri/i.test(hueId);
    // Hue-Bridge-API erwartet "transitiontime" in Zehntelsekunden (Deciseconds) - die
    // Admin-UI zeigt dagegen Millisekunden (verstaendlicher), deshalb hier umrechnen.
    const offFade = Math.round((this.config.offFadeMs || 700) / 100);
    const onFade = Math.round((this.config.onFadeMs || 700) / 100);
    const rgbFactor = this.config.rgbBrightnessFactor;

    let brightnessPercent = 0;
    let rgbString = null;
    let switchState = false;

    if (typeof inputVal === "string" && inputVal.includes(",")) {
      rgbString = inputVal;
      const parts = rgbString.split(",");
      const r = parseFloat(parts[0]) || 0;
      const g = parseFloat(parts[1]) || 0;
      const b = parseFloat(parts[2]) || 0;
      const maxVal = Math.max(r, g, b);
      brightnessPercent =
        maxVal > 100 ? Math.round((maxVal / 255) * 100) : Math.round(maxVal);
    } else {
      brightnessPercent = Math.round(parseFloat(inputVal) || 0);
      if (typeof inputVal === "boolean") {
        brightnessPercent = inputVal ? 100 : 0;
      }
      switchState = brightnessPercent > 0;
    }

    // A) RGB
    if (type.isRGB && rgbString) {
      const [r, g, b] = rgbString
        .split(",")
        .map((v) => Math.round((255 / 100) * parseInt(v.trim() || "0", 10)));
      const hueBri = Math.round((Math.max(r, g, b) / 2.55) * rgbFactor);

      if (hueBri === 0) {
        return {
          groupable: true,
          isOff: true,
          writes: [
            {
              suffix: ".command",
              value: JSON.stringify({ on: false, transitiontime: offFade }),
            },
          ],
        };
      }
      const xy = this.rgbZuXy(r, g, b);

      return {
        groupable: true,
        isOff: false,
        writes: [
          {
            suffix: ".command",
            value: JSON.stringify({
              on: true,
              xy,
              level: hueBri,
              transitiontime: onFade,
            }),
          },
        ],
      };
    }

    // B) Dimmer / White Ambiance
    if (type.isDimmer) {
      if (brightnessPercent <= 0) {
        if (isTradfri) {
          return {
            groupable: false,
            isOff: true,
            writes: [{ suffix: ".on", value: false }],
          };
        }
        return {
          groupable: true,
          isOff: true,
          writes: [
            {
              suffix: ".command",
              value: JSON.stringify({ on: false, transitiontime: offFade }),
            },
          ],
        };
      }

      // Farbtemperatur (mired) bestimmen - zwei ganz unterschiedliche Faelle:
      let miredWert = null;
      if (type.hasCT && rgbString) {
        // Loxone-Ausgang ist RGB, aber diese Hue-Lampe kann nur Helligkeit+Farbtemperatur
        // (kein echtes RGB) - statt die Farbinfo zu ignorieren, wird sie als Farbtemperatur
        // angenaehert (siehe rgbZuMired()). Wird bei JEDER Aenderung neu berechnet (nicht
        // nur beim Einschalten), weil Loxone hier aktiv eine Farbabsicht sendet - anders
        // als der feste Wert unten, wo Loxone gar keine Farbinfo hat.
        const [r, g, b] = rgbString
          .split(",")
          .map((v) => Math.round((255 / 100) * parseInt(v.trim() || "0", 10)));
        miredWert = this.rgbZuMired(r, g, b);
      } else if (
        type.hasCT &&
        this.config.forceWarmWhiteMired &&
        !this.warAn(hueId)
      ) {
        // Loxone-Ausgang ist ein reiner Dimmer (kein RGB, keinerlei Farbinfo) - nur beim
        // Aus->An-Uebergang den konfigurierten Fixwert setzen (siehe warAn()-Kommentar
        // oben), damit spaetere manuelle Hue-App-Anpassungen beim Dimmen erhalten bleiben.
        miredWert = this.config.forceWarmWhiteMired;
      }

      const command = {
        on: true,
        level: brightnessPercent,
        transitiontime: onFade,
      };
      if (miredWert !== null) {
        command.ct = miredWert;
      }

      if (isTradfri) {
        const writes = [{ suffix: ".level", value: brightnessPercent }];
        // Bug gefunden 28.08.: der separate ".ct"-State (genutzt statt .command, weil
        // .command bei Tradfri unzuverlaessig ist) erwartet bei diesem Geraetetyp Kelvin
        // (z.B. hue.0.Tradfri_Ankleide.ct: min 2203, max 4000, unit "K"), nicht mired wie
        // der Hue-API-Standard ".command"-Pfad. forceWarmWhiteMired direkt durchgereicht
        // wurde vom hue-Adapter als "unter Minimum" abgelehnt (Log: "value 454 less than
        // min 2203") - die Lampe hat dadurch nie eine gueltige Farbtemperatur bekommen.
        if (miredWert !== null) {
          const kelvin = Math.round(1000000 / miredWert);
          writes.push({ suffix: ".ct", value: kelvin, delayMs: 800 });
        }
        return { groupable: false, isOff: false, writes };
      }
      return {
        groupable: true,
        isOff: false,
        writes: [{ suffix: ".command", value: JSON.stringify(command) }],
      };
    }

    // C) Schalter
    if (type.isSwitch) {
      return {
        groupable: true,
        isOff: !switchState,
        writes: [{ suffix: ".on", value: switchState }],
      };
    }

    return null;
  }

  async applyCommand(hueId, prefix, cmd) {
    if (!cmd) {
      return;
    }
    for (const w of cmd.writes) {
      if (w.delayMs) {
        setTimeout(
          () =>
            this.setForeignStateAsync(
              hueId + prefix + w.suffix,
              w.value,
              false,
            ),
          w.delayMs,
        );
      } else {
        await this.setForeignStateAsync(
          hueId + prefix + w.suffix,
          w.value,
          false,
        );
      }
    }
  }

  async controlHueDevice(inputVal, hueId) {
    const type = this.deviceCapabilities[hueId];
    if (!type) {
      return;
    }
    try {
      const cmd = await this.computeCommand(inputVal, hueId);
      await this.applyCommand(hueId, type.cmdPrefix, cmd);
    } catch (e) {
      this.log.error(`[${hueId}] ${e.message}`);
    }
  }

  // ---------------------------------------------------------------
  // Debounce/Batch: mehrere Aenderungen im selben kurzen Fenster
  // gemeinsam (parallel) verarbeiten statt einzeln nacheinander.
  // ---------------------------------------------------------------
  scheduleAction(loxoneId, hueId, val) {
    this.pendingChanges.set(hueId, { loxoneId, hueId, val });
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(
        () => this.executeBatch(),
        this.config.debounceMs,
      );
    }
  }

  async executeBatch() {
    this.debounceTimer = null;
    if (this.pendingChanges.size === 0) {
      return;
    }
    const changes = Array.from(this.pendingChanges.values());
    this.pendingChanges = new Map();
    await Promise.all(
      changes.map((c) => this.controlHueDevice(c.val, c.hueId)),
    );
  }

  // ---------------------------------------------------------------
  // Umwandlung eines internen Befehls (adapter-spezifische Feldnamen wie
  // "level" 0-100) in ein rohes Hue-Bridge-Lightstate-Objekt ("bri" 0-254).
  // ---------------------------------------------------------------
  commandZuLightstate(cmd) {
    if (!cmd || !cmd.writes || !cmd.writes.length) {
      return null;
    }
    const cmdWrite = cmd.writes.find((w) => w.suffix === ".command");
    if (cmdWrite) {
      let parsed;
      try {
        parsed = JSON.parse(cmdWrite.value);
      } catch {
        return null;
      }
      const state = {
        on: !!parsed.on,
        transitiontime: parsed.transitiontime || 0,
      };
      if (typeof parsed.level === "number") {
        state.bri = Math.max(1, Math.round(parsed.level * 2.54));
      }
      if (parsed.xy) {
        state.xy = parsed.xy;
      }
      if (parsed.ct) {
        state.ct = parsed.ct;
      }
      return state;
    }
    const onWrite = cmd.writes.find((w) => w.suffix === ".on");
    if (onWrite) {
      return { on: !!onWrite.value };
    }
    return null; // z.B. Tradfri (getrennte .level/.ct-Writes) - nicht szenenfaehig
  }

  // ---------------------------------------------------------------
  // Raeume / Szenen-Cache
  // ---------------------------------------------------------------
  loxoneRoomKey(loxoneBaseId) {
    return loxoneBaseId.substring(0, loxoneBaseId.lastIndexOf("."));
  }

  istManuellerModus(moodNum) {
    return Number(moodNum) < 0;
  }

  async ladeSzenenCache() {
    const id = "cache.szenen";
    await this.setObjectNotExistsAsync(id, {
      type: "state",
      common: {
        name: "Szenen-Cache (Sollwerte je Raum+Stimmung)",
        type: "string",
        role: "json",
        read: true,
        write: true,
        def: "{}",
      },
      native: {},
    });
    const state = await this.getStateAsync(id);
    try {
      this.sceneCache = JSON.parse((state && state.val) || "{}");
    } catch {
      this.sceneCache = {};
    }
  }

  speichereSzenenCacheDebounced() {
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
    }
    this.cacheSaveTimer = setTimeout(() => {
      this.setState("cache.szenen", JSON.stringify(this.sceneCache), true);
    }, 2000);
  }

  markiereDynamisch(roomKey, moodNum) {
    if (!this.sceneCache[roomKey]) {
      this.sceneCache[roomKey] = {};
    }
    const alt = this.sceneCache[roomKey][moodNum];
    if (alt && alt.bridgeSceneId) {
      this.hueBridgeRequest("DELETE", `/scenes/${alt.bridgeSceneId}`).catch(
        () => {},
      );
    }
    this.sceneCache[roomKey][moodNum] = { dynamic: true };
    this.speichereSzenenCacheDebounced();
    this.log.info(
      `[SZENE] ${roomKey} Mood ${moodNum} kommt seit über ${
        this.config.dynamicGiveUpMs / 1000
      }s nicht zur Ruhe -> als dynamisch markiert.`,
    );
  }

  planeSettleCheck(roomKey) {
    const room = this.roomGroups[roomKey];
    if (!room || !room.activeMoodsId) {
      return;
    }
    if (
      room.currentMoodNum !== undefined &&
      room.currentMoodSince &&
      Date.now() - room.currentMoodSince > this.config.dynamicGiveUpMs
    ) {
      this.markiereDynamisch(roomKey, String(room.currentMoodNum));
      if (room.settleTimer) {
        clearTimeout(room.settleTimer);
        room.settleTimer = null;
      }
      return;
    }
    if (room.settleTimer) {
      clearTimeout(room.settleTimer);
    }
    room.settleTimer = setTimeout(
      () => this.snapshotRoom(roomKey),
      this.config.settleMs,
    );
  }

  async aktualisiereBridgeSzene(roomKey, moodNum, snap) {
    const lightIds = [];
    const states = {};
    for (const hueId of Object.keys(snap)) {
      const type = this.deviceCapabilities[hueId];
      if (!type || !type.bridgeId) {
        continue;
      }
      const state = this.commandZuLightstate(snap[hueId]);
      if (!state) {
        continue;
      }
      lightIds.push(type.bridgeId);
      states[type.bridgeId] = state;
    }
    if (lightIds.length < this.config.sceneMinLights) {
      return null;
    }

    const alteSceneId =
      this.sceneCache[roomKey] &&
      this.sceneCache[roomKey][moodNum] &&
      this.sceneCache[roomKey][moodNum].bridgeSceneId;
    if (alteSceneId) {
      try {
        await this.hueBridgeRequest("DELETE", `/scenes/${alteSceneId}`);
      } catch {
        /* egal */
      }
    }
    try {
      const created = await this.hueBridgeRequest("POST", "/scenes", {
        name: `lx_${roomKey.slice(-8)}_${moodNum}`,
        lights: lightIds,
        recycle: true,
      });
      const sceneId =
        created && created[0] && created[0].success && created[0].success.id;
      if (!sceneId) {
        this.log.error(
          `[SZENE] Bridge-Szene für ${roomKey}/${
            moodNum
          } nicht angelegt: ${JSON.stringify(created)}`,
        );
        return null;
      }
      for (const bId of lightIds) {
        await this.hueBridgeRequest(
          "PUT",
          `/scenes/${sceneId}/lightstates/${bId}`,
          states[bId],
        );
      }
      this.log.info(
        `[SZENE] Bridge-Szene für ${roomKey}/${moodNum} angelegt (${sceneId}, ${
          lightIds.length
        } Lampen).`,
      );
      return sceneId;
    } catch (e) {
      this.log.error(
        `[SZENE] Bridge-Szene für ${roomKey}/${moodNum} fehlgeschlagen: ${
          e.message
        }`,
      );
      return null;
    }
  }

  async snapshotRoom(roomKey) {
    const room = this.roomGroups[roomKey];
    if (
      !room ||
      !room.activeMoodsId ||
      !(await this.stateExists(room.activeMoodsId))
    ) {
      return;
    }
    const moodNum = String(await this.getForeignVal(room.activeMoodsId));
    if (this.istManuellerModus(moodNum)) {
      this.log.debug(
        `[SZENE] ${roomKey} Mood ${
          moodNum
        } = manueller Modus -> wird nicht gecacht.`,
      );
      return;
    }
    const snap = {};
    for (const member of room.members) {
      const type = this.deviceCapabilities[member.hueId];
      if (
        !type ||
        !type.fullLoxoneId ||
        !(await this.stateExists(type.fullLoxoneId))
      ) {
        continue;
      }
      const val = await this.getForeignVal(type.fullLoxoneId);
      const cmd = await this.computeCommand(val, member.hueId);
      if (cmd) {
        snap[member.hueId] = cmd;
      }
    }
    const bridgeSceneId = await this.aktualisiereBridgeSzene(
      roomKey,
      moodNum,
      snap,
    );
    if (!this.sceneCache[roomKey]) {
      this.sceneCache[roomKey] = {};
    }
    this.sceneCache[roomKey][moodNum] = {
      lights: snap,
      bridgeSceneId: bridgeSceneId || undefined,
    };
    this.speichereSzenenCacheDebounced();
    this.log.info(
      `[SZENE] ${roomKey} Mood ${moodNum} eingeschwungen, ${
        Object.keys(snap).length
      } Lampen gespeichert${
        bridgeSceneId ? ` (+ Bridge-Szene ${bridgeSceneId})` : ""
      }.`,
    );
  }

  async wendeEinzelnAn(lightsMap) {
    for (const hueId of Object.keys(lightsMap)) {
      const type = this.deviceCapabilities[hueId];
      if (type) {
        await this.applyCommand(hueId, type.cmdPrefix, lightsMap[hueId]);
      }
    }
  }

  async wendeSzeneSofortAn(roomKey, moodNum) {
    if (this.istManuellerModus(moodNum)) {
      this.log.debug(
        `[SZENE] ${roomKey} Mood ${
          moodNum
        } = manueller Modus -> normaler Ablauf.`,
      );
      return;
    }
    const entry =
      this.sceneCache[roomKey] && this.sceneCache[roomKey][String(moodNum)];
    if (entry && entry.dynamic) {
      this.log.debug(
        `[SZENE] ${roomKey} Mood ${moodNum} ist dynamisch -> normaler Ablauf.`,
      );
      return;
    }
    if (!entry) {
      this.log.debug(
        `[SZENE] ${roomKey} Mood ${
          moodNum
        } noch nicht bekannt -> normaler Ablauf.`,
      );
      return;
    }
    const lightsMap = entry.lights || entry;
    if (entry.bridgeSceneId) {
      this.log.info(
        `[SZENE] ${roomKey} Mood ${moodNum} bekannt -> Bridge-Szene ${
          entry.bridgeSceneId
        } abrufen (1 Aufruf statt ${Object.keys(lightsMap).length}).`,
      );
      try {
        await this.hueBridgeRequest("PUT", "/groups/0/action", {
          scene: entry.bridgeSceneId,
        });
      } catch (e) {
        this.log.warn(
          `[SZENE] Bridge-Szenen-Abruf fehlgeschlagen (${
            e.message
          }) -> Einzelbefehle als Rückfall.`,
        );
        await this.wendeEinzelnAn(lightsMap);
      }
      return;
    }
    this.log.debug(
      `[SZENE] ${roomKey} Mood ${moodNum} bekannt -> ${
        Object.keys(lightsMap).length
      } Lampen einzeln sofort setzen.`,
    );
    await this.wendeEinzelnAn(lightsMap);
  }

  // ---------------------------------------------------------------
  // Aus-Wächter: prueft regelmaessig, ob Lampen die laut Loxone aus sein
  // sollen tatsaechlich aus sind (fehlgeschlagene Befehle nachholen).
  // ---------------------------------------------------------------
  async pruefeUndKorrigiereAus() {
    let geprueft = 0;
    let korrigiert = 0;
    for (const roomKey of Object.keys(this.roomGroups)) {
      for (const member of this.roomGroups[roomKey].members) {
        const type = this.deviceCapabilities[member.hueId];
        if (
          !type ||
          !type.fullLoxoneId ||
          !(await this.stateExists(type.fullLoxoneId))
        ) {
          continue;
        }

        const loxoneVal = await this.getForeignVal(type.fullLoxoneId);
        const cmd = await this.computeCommand(loxoneVal, member.hueId);
        if (!cmd || !cmd.isOff) {
          continue;
        }

        const onStateId = `${member.hueId + type.cmdPrefix}.on`;
        if (!(await this.stateExists(onStateId))) {
          continue;
        }
        geprueft++;

        const istAn = (await this.getForeignVal(onStateId)) === true;
        if (!istAn) {
          continue;
        }

        korrigiert++;
        const reachableId = `${member.hueId}.reachable`;
        const reachable = (await this.stateExists(reachableId))
          ? await this.getForeignVal(reachableId)
          : null;
        this.log.info(
          `[WÄCHTER] ${member.hueId} sollte aus sein, ist aber noch an${
            reachable === false ? " (nicht erreichbar!)" : ""
          } -> sende Aus erneut.`,
        );
        await this.applyCommand(member.hueId, type.cmdPrefix, cmd);
      }
    }
    if (korrigiert > 0) {
      this.log.info(
        `[WÄCHTER] ${korrigiert} von ${
          geprueft
        } geprüften "Aus"-Lampen mussten korrigiert werden.`,
      );
    }
  }

  // ---------------------------------------------------------------
  // Baut das "Loxone-Kontext"-Anzeigefeld (Format "Gruppe::Loxone-Name (Type X)")
  // fuer alle Geraete neu auf und schreibt es zurueck in die Konfiguration, falls
  // es sich geaendert hat. Wird sowohl beim Adapter-Start als auch manuell ueber
  // den "Loxone-Kontext aktualisieren"-Button (Admin-UI, sendTo) aufgerufen.
  //
  // "Gruppe" hat seit 28.08. kein eigenes Eingabefeld in der Admin-UI mehr (fuer
  // eine 3-statt-4-spaltige Tabelle) - der Nutzer bearbeitet sie direkt im ersten
  // Segment (vor dem ersten "::") dieses Kontext-Texts. "::" (statt einfachem ":"),
  // damit es sich vom einzelnen ":" im Loxone-eigenen Namen selbst unterscheidet
  // (z.B. "Lichtsteuerung Terrasse: Gartenbeet 1"). Deshalb hier NICHT einfach
  // aus dem alten "group"-Feld neu zusammenbauen (das wuerde jede manuelle Aenderung
  // verwerfen), sondern die Gruppe aus dem *aktuellen* loxoneInfo-Text zurueckparsen
  // und nur den Rest (Loxone-Name, Typ) auffrischen. Fuer alte Eintraege ohne
  // loxoneInfo-Text (Erstmigration) faellt es auf das alte "group"-Feld zurueck.
  //
  // @param devices Geraete-Array (wird in-place veraendert)
  // @param nurBekannteGeraete true = nur schon erkannte Geraete (this.deviceCapabilities)
  //   beruecksichtigen (beim Adapter-Start, subscribeForeignStatesAsync fuer neue
  //   Geraete laeuft parallel ohnehin gerade); false = auch fuer noch unbekannte
  //   Geraete live per detectDevice() nachschlagen (fuer den manuellen Button, damit
  //   frisch gespeicherte, aber noch nicht per Neustart geladene Zeilen auch
  //   funktionieren, ohne den ganzen Adapter neu starten zu muessen).
  // @returns {changed, total}
  // ---------------------------------------------------------------
  async aktualisiereLoxoneKontext(devices, nurBekannteGeraete) {
    let changed = 0;
    let total = 0;
    for (const d of devices) {
      if (!d.loxoneId || !d.hueId) {
        continue;
      }
      total++;
      const normalisierteLoxoneId = d.loxoneId.replace(
        /\.(rgb|position|active)$/,
        "",
      );
      let type = this.deviceCapabilities[d.hueId];
      if (!type && !nurBekannteGeraete) {
        try {
          type = await this.detectDevice(d.hueId, normalisierteLoxoneId);
        } catch {
          /* Hue-Geraet evtl. gerade nicht erreichbar */
        }
      }
      if (!type) {
        continue;
      }
      const loxObj = await this.getForeignObjectAsync(normalisierteLoxoneId);
      const loxName =
        (loxObj && loxObj.common && loxObj.common.name) ||
        normalisierteLoxoneId;
      const typName = type.isRGB ? "RGB" : type.isDimmer ? "Dimmer" : "Switch";
      // Nur dann als "Gruppe::Name (Type X)"-Format vertrauen, wenn es auch danach
      // aussieht (Marker "::") - sonst kommt der Wert evtl. gerade frisch von
      // fillOnSelect (roher Loxone-Name ohne Gruppen-Praefix, User hat den
      // Loxone-Ausgang gerade neu ausgewaehlt) und wuerde faelschlich als Gruppe
      // interpretiert.
      const gruppe =
        d.loxoneInfo && d.loxoneInfo.includes("::")
          ? d.loxoneInfo.split("::")[0]
          : d.group || "";
      const neuerKontext = `${gruppe}::${loxName} (Type ${typName})`;
      if (d.loxoneInfo !== neuerKontext) {
        d.loxoneInfo = neuerKontext;
        changed++;
      }
    }
    if (changed > 0) {
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices },
      });
      this.log.debug(
        `[KONTEXT] ${changed} von ${total} Eintraegen aktualisiert.`,
      );
    }
    return { changed, total };
  }

  // ---------------------------------------------------------------
  // Nachrichten von der Admin-UI (sendTo-Button "Loxone-Kontext aktualisieren").
  // Liest die Konfiguration FRISCH aus der Objects-DB (nicht this.config, das ist
  // nur der eingefrorene Stand vom letzten Adapter-Start) - dadurch wirkt der
  // Button auch auf gerade erst gespeicherte Aenderungen, ganz ohne Neustart.
  // ---------------------------------------------------------------
  async onMessage(obj) {
    if (obj.command === "refreshLoxoneContext") {
      try {
        const selfObj = await this.getForeignObjectAsync(
          `system.adapter.${this.namespace}`,
        );
        const devices =
          (selfObj && selfObj.native && selfObj.native.devices) || [];
        const result = await this.aktualisiereLoxoneKontext(devices, false);
        if (obj.callback) {
          this.sendTo(
            obj.from,
            obj.command,
            {
              native: { devices },
              message: `${result.changed} von ${
                result.total
              } Einträgen aktualisiert.`,
            },
            obj.callback,
          );
        }
      } catch (e) {
        if (obj.callback) {
          this.sendTo(
            obj.from,
            obj.command,
            { error: e.message },
            obj.callback,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------
  async onReady() {
    this.setState("info.connection", false, true);

    if (!this.config.devices || !this.config.devices.length) {
      this.log.warn(
        "Keine Geräte konfiguriert - bitte in der Adapter-Konfiguration die Loxone→Hue-Zuordnung eintragen.",
      );
    }

    try {
      await this.initHueBridge();
    } catch (e) {
      this.log.error(e.message);
      return;
    }
    await this.ladeSzenenCache();

    // Lampen (Tab "Lamps") und Zonen (Tab "Zones", nur Namen+Reihenfolge) sind zwei
    // unabhaengige, flache Listen - eine Lampe verschiebt man einfach, indem man ihr
    // "group"-Feld auf einen anderen Zonennamen setzt. Der Rest des Codes kennt keine
    // Zonen, nur die Loxone-Raumgruppierung (loxoneRoomKey).
    // Loxone-ID normalisieren: der Objekt-Auswahldialog liefert oft den vollen State
    // (z.B. loxone.0.<uuid>.AI9.rgb), waehrend der Rest des Codes mit der Basis-ID ohne
    // .rgb/.position/.active-Suffix arbeitet (der Suffix wird ja selbst je nach erkanntem
    // Lampentyp wieder angehaengt) - beide Eingabeformen funktionieren dadurch gleich gut.
    const devices = (this.config.devices || [])
      .filter((d) => d.loxoneId && d.hueId)
      .map((d) => ({
        ...d,
        loxoneId: d.loxoneId.replace(/\.(rgb|position|active)$/, ""),
      }));

    // Raeume gruppieren
    for (const d of devices) {
      const roomKey = this.loxoneRoomKey(d.loxoneId);
      if (!this.roomGroups[roomKey]) {
        this.roomGroups[roomKey] = {
          members: [],
          activeMoodsId: undefined,
          currentMoodNum: undefined,
          currentMoodSince: undefined,
          settleTimer: null,
        };
      }
      this.roomGroups[roomKey].members.push(d);
    }

    // Geraete erkennen + Loxone-Aenderungen abonnieren
    // WICHTIG: mehrere Hue-Lampen koennen am selben Loxone-Ausgang haengen (z.B. zwei
    // baugleiche Deckenlampen an einem gemeinsamen Analogausgang) - loxoneToHue muss
    // deshalb pro Loxone-ID eine LISTE von Zielen halten, nicht nur ein einzelnes Ziel
    // (sonst ueberschreibt die zweite Lampe beim Setup einfach die erste, die dann nie
    // wieder ein Kommando bekommt - Bug gefunden 28.08. an den Bad-Deckenlampen).
    for (const d of devices) {
      const type = await this.detectDevice(d.hueId, d.loxoneId);
      const roomKey = this.loxoneRoomKey(d.loxoneId);
      if (!this.loxoneToHue.has(type.fullLoxoneId)) {
        this.loxoneToHue.set(type.fullLoxoneId, []);
      }
      this.loxoneToHue.get(type.fullLoxoneId).push({ roomKey, hueId: d.hueId });
      await this.subscribeForeignStatesAsync(type.fullLoxoneId);
    }

    // "Loxone-Kontext"-Anzeigefeld in der Admin-UI aktuell halten (siehe
    // aktualisiereLoxoneKontext() weiter unten fuer Details/Begruendung).
    await this.aktualisiereLoxoneKontext(this.config.devices || [], true);

    // Pro Raum: activeMoodsNum abonnieren, falls vorhanden (Lichtsteuerungsbaustein)
    for (const roomKey of Object.keys(this.roomGroups)) {
      const activeMoodsId = `${roomKey}.activeMoodsNum`;
      if (await this.stateExists(activeMoodsId)) {
        const room = this.roomGroups[roomKey];
        room.activeMoodsId = activeMoodsId;
        room.currentMoodNum = await this.getForeignVal(activeMoodsId);
        room.currentMoodSince = Date.now();
        this.activeMoodsToRoom.set(activeMoodsId, roomKey);
        await this.subscribeForeignStatesAsync(activeMoodsId);
        this.log.info(
          `[SZENE] ${roomKey}: Lichtsteuerungsbaustein erkannt, ${
            this.roomGroups[roomKey].members.length
          } Lampen.`,
        );
      }
    }

    this.watchdogInterval = this.setInterval(
      () => this.pruefeUndKorrigiereAus(),
      this.config.watchdogIntervalMin * 60000,
    );

    this.setState("info.connection", true, true);
    this.log.info(
      `lox2hue bereit: ${devices.length} Geräte in ${
        Object.keys(this.roomGroups).length
      } Räumen.`,
    );
  }

  onStateChange(id, state) {
    if (!state) {
      return;
    }

    const roomKey = this.activeMoodsToRoom.get(id);
    if (roomKey) {
      const room = this.roomGroups[roomKey];
      room.currentMoodNum = state.val;
      room.currentMoodSince = Date.now();
      this.wendeSzeneSofortAn(roomKey, state.val).catch((e) =>
        this.log.error(e.message),
      );
      return;
    }

    const targets = this.loxoneToHue.get(id);
    if (targets) {
      for (const target of targets) {
        this.scheduleAction(id, target.hueId, state.val);
        this.planeSettleCheck(target.roomKey);
      }
    }
  }

  onUnload(callback) {
    try {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      if (this.cacheSaveTimer) {
        clearTimeout(this.cacheSaveTimer);
      }
      if (this.watchdogInterval) {
        this.clearInterval(this.watchdogInterval);
      }
      for (const roomKey of Object.keys(this.roomGroups)) {
        if (this.roomGroups[roomKey].settleTimer) {
          clearTimeout(this.roomGroups[roomKey].settleTimer);
        }
      }
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Loxone2Hue(options);
} else {
  new Loxone2Hue();
}

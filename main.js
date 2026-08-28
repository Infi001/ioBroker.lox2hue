'use strict';

/*
 * ioBroker.lox2hue
 *
 * Mirrors Loxone light-control moods (LightControllerV2) onto Philips Hue lamps.
 * Loxone stays the master: every change on a configured Loxone analog output
 * (.rgb / .position / .active) is forwarded immediately to the assigned Hue lamp.
 *
 * The adapter additionally learns, per room (Loxone light-control block) and mood
 * (activeMoodsNum), the target values of all assigned lamps. Once a mood has
 * "settled" (8s with no further change), the adapter creates its own minimal
 * Philips Hue bridge scene for it. The next time that same mood is triggered, only
 * that one scene is recalled (a single bridge call) instead of N individual
 * commands - this fixes the staggered/sequential switching that plain per-lamp
 * control causes via the bridge/Zigbee processing.
 *
 * Two cases are excluded from caching automatically (detected purely by behavior,
 * not by name):
 *  - Manual mode: Loxone reports activeMoodsNum < 0 whenever no defined mood
 *    matches exactly anymore (e.g. because a lamp was readjusted by hand).
 *  - Dynamic scenes (e.g. "Party"): if a mood doesn't settle within
 *    dynamicGiveUpMs, it's treated as dynamic and permanently excluded.
 */

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const commandLogic = require('./lib/commandLogic');

/**
 * Human-readable capability label for logs and the admin UI's Loxone-context
 * display. Returns 'Unknown' when detection found no usable capability at all
 * (e.g. a deleted Hue device or a typo'd id) - previously this silently fell
 * through to 'Switch', making a completely broken mapping look like a correctly
 * detected on/off device.
 *
 * @param {object} type Device capabilities as produced by detectDevice()
 * @returns {'RGB'|'Dimmer'|'Switch'|'Unknown'} The detected capability label
 */
function capabilityLabel(type) {
    if (type.isRGB) {
        return 'RGB';
    }
    if (type.isDimmer) {
        return 'Dimmer';
    }
    if (type.isSwitch) {
        return 'Switch';
    }
    return 'Unknown';
}

class Loxone2Hue extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'lox2hue' });

        this.deviceCapabilities = {}; // hueId -> { isGroup, cmdPrefix, isRGB, hasCT, isDimmer, isSwitch, loxoneSuffix, fullLoxoneId, bridgeId }
        this.roomGroups = {}; // roomKey -> { members: [{loxoneId,hueId}], activeMoodsId, currentMoodNum, currentMoodSince, settleTimer }
        this.sceneCache = {}; // roomKey -> { [moodNum]: { lights: {...}, bridgeSceneId } | { dynamic:true } }
        this.pendingChanges = new Map(); // hueId -> { loxoneId, hueId, val }
        this.loxoneToHue = new Map(); // fullLoxoneId -> Array<{ roomKey, hueId }> (multiple lamps per Loxone output are possible)
        this.activeMoodsToRoom = new Map(); // activeMoodsId -> roomKey
        this.debounceTimer = null;
        this.cacheSaveTimer = null;
        this.watchdogInterval = null;
        this.stateExistsCache = new Map(); // id -> boolean, small shortcut for repeated existsState lookups
        this.lastKnownOn = new Map(); // hueId -> boolean, purely internal (no bridge round-trip) for wasOn()
        this.bridgeReachable = undefined; // tracked live via hueBridgeRequest()/onReady(), see setBridgeReachable()

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------------------------------------------------------
    // Helpers: state existence/access with a small cache
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
    // Talk to the Hue bridge directly (bypassing the adapter abstraction) - needed
    // for scene creation/recall, which iobroker.hue itself cannot do.
    // ---------------------------------------------------------------
    async initHueBridge() {
        // Bridge IP/port are conveniently taken from the hue adapter's own config
        // (not protected there), as a default/fallback if not explicitly set on this
        // adapter instance. The API user/token ("user") is marked as "protectedNative"
        // on iobroker.hue and therefore CANNOT be read via getForeignObject from
        // ANOTHER adapter (comes back as undefined, even though the CLI/admin UI shows
        // it) - it must therefore be entered explicitly in this adapter's own config.
        let fallbackHost, fallbackPort;
        try {
            const hueAdapterObj = await this.getForeignObjectAsync(`system.adapter.${this.config.hueInstance}`);
            if (hueAdapterObj && hueAdapterObj.native) {
                fallbackHost = hueAdapterObj.native.bridge;
                fallbackPort = hueAdapterObj.native.port;
            }
        } catch {
            /* fine, fall back to just this adapter's own config */
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

    // ---------------------------------------------------------------
    // Marks the Hue bridge as (un)reachable, and updates info.connection to reflect
    // live connectivity rather than just "adapter start-up succeeded" - previously
    // info.connection was set true once at the end of onReady() and never touched
    // again, so a bridge that went offline later stayed silently invisible (still
    // reported as connected) other than error-level log lines.
    // ---------------------------------------------------------------
    setBridgeReachable(reachable) {
        if (this.bridgeReachable === reachable) {
            return;
        }
        this.bridgeReachable = reachable;
        this.setState('info.connection', reachable, true);
        if (reachable) {
            this.log.info('Hue-Bridge erreichbar.');
        } else {
            this.log.warn('Hue-Bridge nicht erreichbar - Netzwerk/Bridge-Status prüfen.');
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
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(data),
                          }
                        : {},
                },
                res => {
                    let chunks = '';
                    res.on('data', c => {
                        chunks += c;
                    });
                    res.on('end', () => {
                        this.setBridgeReachable(true);
                        try {
                            resolve(JSON.parse(chunks));
                        } catch {
                            resolve(null);
                        }
                    });
                },
            );
            req.on('error', err => {
                this.setBridgeReachable(false);
                reject(err);
            });
            req.setTimeout(5000, () => {
                this.setBridgeReachable(false);
                req.destroy(new Error('Timeout'));
            });
            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    // ---------------------------------------------------------------
    // Device detection (RGB / Dimmer / Switch, group or single lamp)
    // ---------------------------------------------------------------
    async detectDevice(hueId, loxoneBaseId) {
        if (this.deviceCapabilities[hueId]) {
            return this.deviceCapabilities[hueId];
        }

        const isGroup = await this.stateExists(`${hueId}.action.on`);
        const cmdPrefix = isGroup ? '.action' : '';

        const hasXY =
            (await this.stateExists(`${hueId + cmdPrefix}.xy`)) || (await this.stateExists(`${hueId + cmdPrefix}.hue`));
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
            loxoneSuffix: '',
            fullLoxoneId: null,
            bridgeId: null,
        };

        if (type.isRGB) {
            type.loxoneSuffix = '.rgb';
        } else if (type.isDimmer) {
            // White-ambiance lamp (no real RGB) - still subscribe to ".rgb" instead of
            // ".position" WHEN this Loxone output is itself configured as a genuine
            // color picker (Loxone block type "ColorPickerV2"/"ColorPicker", not
            // "Dimmer") - then the color intent can be approximated as a color
            // temperature (see rgbToMired() usage in lib/commandLogic.js). A plain
            // "Dimmer" block, on the other hand, has no color info at all, so
            // ".position" remains correct there. User request 28.08.
            let loxoneIsColorPicker = false;
            if (loxoneBaseId) {
                const loxObj = await this.getForeignObjectAsync(loxoneBaseId);
                const controlType = loxObj && loxObj.native && loxObj.native.control && loxObj.native.control.type;
                loxoneIsColorPicker = /color/i.test(controlType || '');
            }
            type.loxoneSuffix = loxoneIsColorPicker ? '.rgb' : '.position';
        } else {
            type.loxoneSuffix = '.active';
        }

        type.fullLoxoneId = loxoneBaseId ? loxoneBaseId + type.loxoneSuffix : null;

        const hueObj = await this.getForeignObjectAsync(hueId);
        type.bridgeId = hueObj && hueObj.native && hueObj.native.id;

        this.deviceCapabilities[hueId] = type;
        const label = capabilityLabel(type);
        if (label === 'Unknown') {
            // None of .on/.level/.xy/.hue exist under this id at all - most likely a
            // typo'd Hue object id, or a lamp that was since deleted from the bridge.
            // Without this warning such a mapping fails completely silently.
            this.log.warn(
                `[${hueId}] keine Fähigkeiten erkannt (.on/.level/.xy/.hue fehlen alle) - Hue-Objekt-ID prüfen, existiert die Lampe noch?`,
            );
        }
        this.log.debug(
            `[INIT] ${hueId} (${isGroup ? 'GRUPPE' : 'LAMPE'}), Typ ${label}, lauscht auf ${type.loxoneSuffix}`,
        );
        return type;
    }

    // ---------------------------------------------------------------
    // Checks whether a lamp was on BEFORE this command - used to only apply the
    // fixed color temperature on the off->on transition, not on every brightness
    // change while it's already on (otherwise a color temperature chosen manually in
    // the Hue app would get overwritten on every dim step - user request 28.08., so
    // the Hue app stays usable for color temperature, the way it was handled before
    // this adapter existed).
    //
    // Deliberately NOT the live Hue state (".on"), but a purely internally tracked
    // value (lastKnownOn) - the live state can take a very long time (several
    // minutes, observed on 27./28.08.) to be reported back by the bridge/hue
    // adapter, which would make it far too unreliable as a basis for this decision.
    // ---------------------------------------------------------------
    wasOn(hueId) {
        return this.lastKnownOn.get(hueId) === true;
    }

    // ---------------------------------------------------------------
    // Stateful wrapper around commandLogic.computeRawCommand(): looks up this
    // device's capabilities/wasOn() state, delegates the actual (pure, unit-tested)
    // decision to lib/commandLogic.js, then remembers whether the lamp will now be
    // on or off (for wasOn() on the next call, see above).
    // ---------------------------------------------------------------
    async computeCommand(inputVal, hueId) {
        const type = this.deviceCapabilities[hueId];
        if (!type) {
            return null;
        }
        const cmd = commandLogic.computeRawCommand({
            inputVal,
            type,
            isTradfri: /tradfri/i.test(hueId),
            wasOn: this.wasOn(hueId),
            config: {
                offFadeMs: this.config.offFadeMs,
                onFadeMs: this.config.onFadeMs,
                rgbBrightnessFactor: this.config.rgbBrightnessFactor,
                forceWarmWhiteMired: this.config.forceWarmWhiteMired,
            },
        });
        if (cmd) {
            this.lastKnownOn.set(hueId, !cmd.isOff);
        }
        return cmd;
    }

    async applyCommand(hueId, prefix, cmd) {
        if (!cmd) {
            return;
        }
        for (const w of cmd.writes) {
            if (w.delayMs) {
                this.setTimeout(() => this.setForeignStateAsync(hueId + prefix + w.suffix, w.value, false), w.delayMs);
            } else {
                await this.setForeignStateAsync(hueId + prefix + w.suffix, w.value, false);
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
    // Debounce/batch: process several changes within the same short window together
    // (in parallel) instead of one after another.
    // ---------------------------------------------------------------
    scheduleAction(loxoneId, hueId, val) {
        this.pendingChanges.set(hueId, { loxoneId, hueId, val });
        if (!this.debounceTimer) {
            this.debounceTimer = this.setTimeout(() => this.executeBatch(), this.config.debounceMs);
        }
    }

    async executeBatch() {
        this.debounceTimer = null;
        if (this.pendingChanges.size === 0) {
            return;
        }
        const changes = Array.from(this.pendingChanges.values());
        this.pendingChanges = new Map();
        await Promise.all(changes.map(c => this.controlHueDevice(c.val, c.hueId)));
    }

    // ---------------------------------------------------------------
    // Converts an internal command (adapter-specific field names such as "level"
    // 0-100) into a raw Hue bridge lightstate object ("bri" 0-254).
    // ---------------------------------------------------------------
    commandToLightstate(cmd) {
        if (!cmd || !cmd.writes || !cmd.writes.length) {
            return null;
        }
        const cmdWrite = cmd.writes.find(w => w.suffix === '.command');
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
            if (typeof parsed.level === 'number') {
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
        const onWrite = cmd.writes.find(w => w.suffix === '.on');
        if (onWrite) {
            return { on: !!onWrite.value };
        }
        return null; // e.g. Tradfri (separate .level/.ct writes) - not scene-capable
    }

    // ---------------------------------------------------------------
    // Rooms / scene cache
    // ---------------------------------------------------------------
    loxoneRoomKey(loxoneBaseId) {
        return loxoneBaseId.substring(0, loxoneBaseId.lastIndexOf('.'));
    }

    isManualMode(moodNum) {
        return Number(moodNum) < 0;
    }

    async loadSceneCache() {
        const id = 'cache.szenen';
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: 'Szenen-Cache (Sollwerte je Raum+Stimmung)',
                type: 'string',
                role: 'json',
                read: true,
                write: true,
                def: '{}',
            },
            native: {},
        });
        const state = await this.getStateAsync(id);
        try {
            this.sceneCache = JSON.parse((state && state.val) || '{}');
        } catch {
            this.sceneCache = {};
        }
    }

    saveSceneCacheDebounced() {
        if (this.cacheSaveTimer) {
            this.clearTimeout(this.cacheSaveTimer);
        }
        this.cacheSaveTimer = this.setTimeout(() => {
            this.setState('cache.szenen', JSON.stringify(this.sceneCache), true);
        }, 2000);
    }

    markDynamic(roomKey, moodNum) {
        if (!this.sceneCache[roomKey]) {
            this.sceneCache[roomKey] = {};
        }
        const previous = this.sceneCache[roomKey][moodNum];
        if (previous && previous.bridgeSceneId) {
            this.hueBridgeRequest('DELETE', `/scenes/${previous.bridgeSceneId}`).catch(() => {});
        }
        this.sceneCache[roomKey][moodNum] = { dynamic: true };
        this.saveSceneCacheDebounced();
        this.log.info(
            `[SZENE] ${roomKey} Mood ${moodNum} kommt seit über ${
                this.config.dynamicGiveUpMs / 1000
            }s nicht zur Ruhe -> als dynamisch markiert.`,
        );
    }

    scheduleSettleCheck(roomKey) {
        const room = this.roomGroups[roomKey];
        if (!room || !room.activeMoodsId) {
            return;
        }
        if (
            room.currentMoodNum !== undefined &&
            room.currentMoodSince &&
            Date.now() - room.currentMoodSince > this.config.dynamicGiveUpMs
        ) {
            this.markDynamic(roomKey, String(room.currentMoodNum));
            if (room.settleTimer) {
                this.clearTimeout(room.settleTimer);
                room.settleTimer = null;
            }
            return;
        }
        if (room.settleTimer) {
            this.clearTimeout(room.settleTimer);
        }
        room.settleTimer = this.setTimeout(() => this.snapshotRoom(roomKey), this.config.settleMs);
    }

    async updateBridgeScene(roomKey, moodNum, snap) {
        const lightIds = [];
        const states = {};
        for (const hueId of Object.keys(snap)) {
            const type = this.deviceCapabilities[hueId];
            if (!type || !type.bridgeId) {
                continue;
            }
            const state = this.commandToLightstate(snap[hueId]);
            if (!state) {
                continue;
            }
            lightIds.push(type.bridgeId);
            states[type.bridgeId] = state;
        }
        if (lightIds.length < this.config.sceneMinLights) {
            return null;
        }

        const previousSceneId =
            this.sceneCache[roomKey] &&
            this.sceneCache[roomKey][moodNum] &&
            this.sceneCache[roomKey][moodNum].bridgeSceneId;
        if (previousSceneId) {
            try {
                await this.hueBridgeRequest('DELETE', `/scenes/${previousSceneId}`);
            } catch {
                /* fine */
            }
        }
        try {
            const created = await this.hueBridgeRequest('POST', '/scenes', {
                name: `lx_${roomKey.slice(-8)}_${moodNum}`,
                lights: lightIds,
                recycle: true,
            });
            const sceneId = created && created[0] && created[0].success && created[0].success.id;
            if (!sceneId) {
                this.log.error(
                    `[SZENE] Bridge-Szene für ${roomKey}/${moodNum} nicht angelegt: ${JSON.stringify(created)}`,
                );
                return null;
            }
            for (const bId of lightIds) {
                await this.hueBridgeRequest('PUT', `/scenes/${sceneId}/lightstates/${bId}`, states[bId]);
            }
            this.log.info(
                `[SZENE] Bridge-Szene für ${roomKey}/${moodNum} angelegt (${sceneId}, ${lightIds.length} Lampen).`,
            );
            return sceneId;
        } catch (e) {
            this.log.error(`[SZENE] Bridge-Szene für ${roomKey}/${moodNum} fehlgeschlagen: ${e.message}`);
            return null;
        }
    }

    async snapshotRoom(roomKey) {
        const room = this.roomGroups[roomKey];
        if (!room || !room.activeMoodsId || !(await this.stateExists(room.activeMoodsId))) {
            return;
        }
        const moodNum = String(await this.getForeignVal(room.activeMoodsId));
        if (this.isManualMode(moodNum)) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodNum} = manueller Modus -> wird nicht gecacht.`);
            return;
        }
        const snap = {};
        for (const member of room.members) {
            const type = this.deviceCapabilities[member.hueId];
            if (!type || !type.fullLoxoneId || !(await this.stateExists(type.fullLoxoneId))) {
                continue;
            }
            const val = await this.getForeignVal(type.fullLoxoneId);
            const cmd = await this.computeCommand(val, member.hueId);
            if (cmd) {
                snap[member.hueId] = cmd;
            }
        }
        const bridgeSceneId = await this.updateBridgeScene(roomKey, moodNum, snap);
        if (!this.sceneCache[roomKey]) {
            this.sceneCache[roomKey] = {};
        }
        this.sceneCache[roomKey][moodNum] = {
            lights: snap,
            bridgeSceneId: bridgeSceneId || undefined,
        };
        this.saveSceneCacheDebounced();
        this.log.info(
            `[SZENE] ${roomKey} Mood ${moodNum} eingeschwungen, ${Object.keys(snap).length} Lampen gespeichert${
                bridgeSceneId ? ` (+ Bridge-Szene ${bridgeSceneId})` : ''
            }.`,
        );
    }

    async applyIndividually(lightsMap) {
        for (const hueId of Object.keys(lightsMap)) {
            const type = this.deviceCapabilities[hueId];
            if (type) {
                await this.applyCommand(hueId, type.cmdPrefix, lightsMap[hueId]);
            }
        }
    }

    async applySceneImmediately(roomKey, moodNum) {
        if (this.isManualMode(moodNum)) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodNum} = manueller Modus -> normaler Ablauf.`);
            return;
        }
        const entry = this.sceneCache[roomKey] && this.sceneCache[roomKey][String(moodNum)];
        if (entry && entry.dynamic) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodNum} ist dynamisch -> normaler Ablauf.`);
            return;
        }
        if (!entry) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodNum} noch nicht bekannt -> normaler Ablauf.`);
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
                await this.hueBridgeRequest('PUT', '/groups/0/action', {
                    scene: entry.bridgeSceneId,
                });
            } catch (e) {
                this.log.warn(
                    `[SZENE] Bridge-Szenen-Abruf fehlgeschlagen (${e.message}) -> Einzelbefehle als Rückfall.`,
                );
                await this.applyIndividually(lightsMap);
            }
            return;
        }
        this.log.debug(
            `[SZENE] ${roomKey} Mood ${moodNum} bekannt -> ${
                Object.keys(lightsMap).length
            } Lampen einzeln sofort setzen.`,
        );
        await this.applyIndividually(lightsMap);
    }

    // ---------------------------------------------------------------
    // Off watchdog: periodically checks whether lamps that should be off according
    // to Loxone actually are (and re-sends failed commands).
    // ---------------------------------------------------------------
    async checkAndCorrectOff() {
        let checked = 0;
        let corrected = 0;
        for (const roomKey of Object.keys(this.roomGroups)) {
            for (const member of this.roomGroups[roomKey].members) {
                const type = this.deviceCapabilities[member.hueId];
                if (!type || !type.fullLoxoneId || !(await this.stateExists(type.fullLoxoneId))) {
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
                checked++;

                const isOn = (await this.getForeignVal(onStateId)) === true;
                if (!isOn) {
                    continue;
                }

                corrected++;
                const reachableId = `${member.hueId}.reachable`;
                const reachable = (await this.stateExists(reachableId)) ? await this.getForeignVal(reachableId) : null;
                this.log.info(
                    `[WÄCHTER] ${member.hueId} sollte aus sein, ist aber noch an${
                        reachable === false ? ' (nicht erreichbar!)' : ''
                    } -> sende Aus erneut.`,
                );
                await this.applyCommand(member.hueId, type.cmdPrefix, cmd);
            }
        }
        if (corrected > 0) {
            this.log.info(`[WÄCHTER] ${corrected} von ${checked} geprüften "Aus"-Lampen mussten korrigiert werden.`);
        }
    }

    // ---------------------------------------------------------------
    // (Re)builds the "Loxone context" display field (format "Group::Loxone name
    // (Type X)") for all devices and writes it back into the configuration if it
    // changed. Called both on adapter start and manually via the "Refresh Loxone
    // context" button (admin UI, sendTo).
    //
    // "Group" no longer has its own input field in the admin UI as of 28.08. (to
    // keep the table at three columns instead of four) - the user edits it directly
    // in the first segment (before the first "::") of this context text. "::"
    // (instead of a plain ":") so it's distinguishable from a single ":" that can
    // appear in Loxone's own name (e.g. "Lichtsteuerung Terrasse: Gartenbeet 1").
    // That's why this does NOT simply rebuild from the old "group" field (which
    // would discard any manual edit) - instead the group is parsed back out of the
    // *current* loxoneInfo text, and only the rest (Loxone name, type) is
    // refreshed. Falls back to the old "group" field for legacy entries without a
    // loxoneInfo text yet (initial migration).
    //
    // @param devices Device array (mutated in place)
    // @param onlyKnownDevices true = only consider already-detected devices
    //   (this.deviceCapabilities) (on adapter start, subscribeForeignStatesAsync for
    //   new devices is running in parallel anyway); false = also look up not-yet-known
    //   devices live via detectDevice() (for the manual button, so freshly saved but
    //   not-yet-restarted rows also work, without having to restart the whole adapter)
    // @returns {changed, total}
    // ---------------------------------------------------------------
    async updateLoxoneContext(devices, onlyKnownDevices) {
        let changed = 0;
        let total = 0;
        await Promise.all(
            devices.map(async d => {
                if (!d.loxoneId || !d.hueId) {
                    return;
                }
                total++;
                const normalizedLoxoneId = d.loxoneId.replace(/\.(rgb|position|active)$/, '');
                let type = this.deviceCapabilities[d.hueId];
                if (!type && !onlyKnownDevices) {
                    try {
                        type = await this.detectDevice(d.hueId, normalizedLoxoneId);
                    } catch {
                        /* Hue device possibly unreachable right now */
                    }
                }
                if (!type) {
                    return;
                }
                const loxObj = await this.getForeignObjectAsync(normalizedLoxoneId);
                const loxoneName = (loxObj && loxObj.common && loxObj.common.name) || normalizedLoxoneId;
                const typeName = capabilityLabel(type);
                // Only trust the value as "Group::Name (Type X)" if it actually looks
                // like it (marker "::") - otherwise the value might just have come
                // fresh from fillOnSelect (raw Loxone name without a group prefix,
                // user just picked a new Loxone output) and would be wrongly
                // interpreted as the group.
                const group = d.loxoneInfo && d.loxoneInfo.includes('::') ? d.loxoneInfo.split('::')[0] : d.group || '';
                const newContext = `${group}::${loxoneName} (Type ${typeName})`;
                if (d.loxoneInfo !== newContext) {
                    d.loxoneInfo = newContext;
                    changed++;
                }
            }),
        );
        if (changed > 0) {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { devices },
            });
            this.log.debug(`[KONTEXT] ${changed} von ${total} Eintraegen aktualisiert.`);
        }
        return { changed, total };
    }

    // ---------------------------------------------------------------
    // Messages from the admin UI ("Refresh Loxone context" sendTo button). Reads
    // the configuration FRESH from the objects DB (not this.config, which is only
    // the frozen snapshot from the last adapter start) - this way the button also
    // works on changes that were just saved, with no restart needed.
    // ---------------------------------------------------------------
    async onMessage(obj) {
        if (obj.command === 'refreshLoxoneContext') {
            try {
                const selfObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                const devices = (selfObj && selfObj.native && selfObj.native.devices) || [];
                const result = await this.updateLoxoneContext(devices, false);
                if (obj.callback) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        {
                            native: { devices },
                            message: `${result.changed} von ${result.total} Einträgen aktualisiert.`,
                        },
                        obj.callback,
                    );
                }
            } catch (e) {
                this.log.error(`[refreshLoxoneContext] ${e.message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
                }
            }
        }
    }

    // ---------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------
    async onReady() {
        this.setState('info.connection', false, true);

        if (!this.config.devices || !this.config.devices.length) {
            this.log.warn(
                'Keine Geräte konfiguriert - bitte in der Adapter-Konfiguration die Loxone→Hue-Zuordnung eintragen.',
            );
        }

        try {
            await this.initHueBridge();
        } catch (e) {
            this.log.error(e.message);
            return;
        }
        await this.loadSceneCache();

        // Lamps (tab "Lamps") and zones (tab "Zones", names+order only) are two
        // independent, flat lists - a lamp is moved between zones simply by setting
        // its "group" field to a different zone name. The rest of the code doesn't
        // know about zones at all, only Loxone room grouping (loxoneRoomKey).
        // Normalize the Loxone id: the object-selection dialog often returns the
        // full state (e.g. loxone.0.<uuid>.AI9.rgb), while the rest of the code
        // works with the base id without a .rgb/.position/.active suffix (the
        // suffix is re-appended anyway depending on the detected lamp type) - both
        // input forms therefore work equally well.
        const devices = (this.config.devices || [])
            .filter(d => d.loxoneId && d.hueId)
            .map(d => ({
                ...d,
                loxoneId: d.loxoneId.replace(/\.(rgb|position|active)$/, ''),
            }));

        // Group into rooms
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

        // Detect devices + subscribe to Loxone changes. Processed concurrently
        // (Promise.all) rather than one device at a time, since each device's
        // detection/subscription is independent - this keeps start-up time roughly
        // constant instead of growing linearly with the number of configured lamps.
        //
        // IMPORTANT: several Hue lamps can hang off the same Loxone output (e.g. two
        // identical ceiling lamps on one shared analog output) - loxoneToHue must
        // therefore hold a LIST of targets per Loxone id, not just a single target
        // (otherwise the second lamp would simply overwrite the first one during
        // setup, and the first would then never receive another command - bug found
        // 28.08. on the bathroom ceiling lamps).
        await Promise.all(
            devices.map(async d => {
                const type = await this.detectDevice(d.hueId, d.loxoneId);
                const roomKey = this.loxoneRoomKey(d.loxoneId);
                if (!this.loxoneToHue.has(type.fullLoxoneId)) {
                    this.loxoneToHue.set(type.fullLoxoneId, []);
                }
                this.loxoneToHue.get(type.fullLoxoneId).push({ roomKey, hueId: d.hueId });
                await this.subscribeForeignStatesAsync(type.fullLoxoneId);
            }),
        );

        // Keep the "Loxone context" display field in the admin UI up to date (see
        // updateLoxoneContext() above for details/reasoning).
        await this.updateLoxoneContext(this.config.devices || [], true);

        // Per room: subscribe to activeMoodsNum, if present (light-control block)
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
            () => this.checkAndCorrectOff(),
            this.config.watchdogIntervalMin * 60000,
        );

        this.setBridgeReachable(true);
        this.log.info(`lox2hue bereit: ${devices.length} Geräte in ${Object.keys(this.roomGroups).length} Räumen.`);
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
            this.applySceneImmediately(roomKey, state.val).catch(e => this.log.error(e.message));
            return;
        }

        const targets = this.loxoneToHue.get(id);
        if (targets) {
            for (const target of targets) {
                this.scheduleAction(id, target.hueId, state.val);
                this.scheduleSettleCheck(target.roomKey);
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.debounceTimer) {
                this.clearTimeout(this.debounceTimer);
            }
            if (this.cacheSaveTimer) {
                this.clearTimeout(this.cacheSaveTimer);
            }
            if (this.watchdogInterval) {
                this.clearInterval(this.watchdogInterval);
            }
            for (const roomKey of Object.keys(this.roomGroups)) {
                if (this.roomGroups[roomKey].settleTimer) {
                    this.clearTimeout(this.roomGroups[roomKey].settleTimer);
                }
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Loxone2Hue(options);
} else {
    new Loxone2Hue();
}

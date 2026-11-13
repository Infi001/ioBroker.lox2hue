'use strict';

/*
 * ioBroker.lox2hue
 *
 * Mirrors Loxone light-control moods (LightControllerV2) onto Philips Hue lamps.
 * Learns settled per-room moods and caches them as Philips Hue CLIP v2 scenes
 * inside a dedicated "lox2hue (Cache)" zone for single-call recall.
 */

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const commandLogic = require('./lib/commandLogic');
const sceneStateMachine = require('./lib/sceneStateMachine');

const CACHE_SCHEMA_VERSION = 2;
const LEGACY_CACHE_ZONE_NAME = 'lox2hue (Cache)';
const CACHE_ZONE_PREFIX = 'lox2hue: ';
const RECALL_SUPPRESS_MS = 1500;
const WATCHDOG_GRACE_MS = 15000;
const LOXONE_SUFFIX_RE = /\.(rgb|position|active)$/;

const stripLoxoneSuffix = id => id.replace(LOXONE_SUFFIX_RE, '');
const loxoneRoomKey = loxoneBaseId => loxoneBaseId.substring(0, loxoneBaseId.lastIndexOf('.'));
const extractRid = items => (items && items[0] && items[0].rid ? items[0].rid : null);
const capabilityLabel = type => (type.isRGB ? 'RGB' : type.isDimmer ? 'Dimmer' : type.isSwitch ? 'Switch' : 'Unknown');

class Loxone2Hue extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'lox2hue' });

        this.deviceCapabilities = {};
        this.roomGroups = {};
        this.sceneCache = { version: CACHE_SCHEMA_VERSION, rooms: {} };
        this.pendingChanges = new Map();
        this.loxoneToHue = new Map();
        this.activeMoodsToRoom = new Map();
        this.v2LightsByV1Id = new Map();
        this.v2ZonesByRoom = new Map(); // roomKey -> { id, lightIds }
        this.debounceTimer = null;
        this.cacheSaveTimer = null;
        this.cacheDirty = false;
        this.watchdogInterval = null;
        this.stateExistsCache = new Map();
        this.lastKnownOn = new Map();
        this.bridgeReachable = undefined;
        this.bridgeFailureStreak = 0;
        this.bridgeQueue = Promise.resolve();
        this.bridgeAgent = new https.Agent({ keepAlive: true, maxSockets: 2, rejectUnauthorized: false });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    clearTimer(owner, prop) {
        if (owner[prop]) {
            this.clearTimeout(owner[prop]);
            owner[prop] = null;
        }
    }

    async stateExists(id) {
        if (!this.stateExistsCache.has(id)) {
            this.stateExistsCache.set(id, !!(await this.getForeignObjectAsync(id)));
        }
        return this.stateExistsCache.get(id);
    }

    async getForeignVal(id) {
        const s = await this.getForeignStateAsync(id);
        return s ? s.val : undefined;
    }

    // ---------------------------------------------------------------
    // Hue Bridge HTTPS client (CLIP v2 primary + legacy v1 cleanup)
    // ---------------------------------------------------------------
    async initHueBridge() {
        let fallbackHost;
        let fallbackPort;
        try {
            const hueObj = await this.getForeignObjectAsync(`system.adapter.${this.config.hueInstance}`);
            fallbackHost = hueObj && hueObj.native && hueObj.native.bridge;
            fallbackPort = hueObj && hueObj.native && hueObj.native.port;
        } catch {
            /* fall back to own config */
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
                    `(zu finden in der Konfiguration der ${this.config.hueInstance}-Instanz, Feld "Nutzer"/"user").`,
            );
        }
    }

    setBridgeReachable(reachable, immediate = false) {
        if (reachable) {
            this.bridgeFailureStreak = 0;
        } else {
            this.bridgeFailureStreak++;
            if (!immediate && this.bridgeReachable === true && this.bridgeFailureStreak < 2) {
                return;
            }
        }
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

    enqueueBridgeRequest(fn) {
        const run = this.bridgeQueue.then(fn, fn);
        this.bridgeQueue = run.catch(() => {});
        return run;
    }

    rawHttpsJson(method, path, body, useClipV2Header = true) {
        return this.enqueueBridgeRequest(
            () =>
                new Promise((resolve, reject) => {
                    const data = body !== undefined ? JSON.stringify(body) : undefined;
                    const headers = {};
                    if (useClipV2Header) {
                        headers['hue-application-key'] = this.hueBridgeUser;
                    }
                    if (data) {
                        headers['Content-Type'] = 'application/json';
                        headers['Content-Length'] = Buffer.byteLength(data);
                    }
                    const req = https.request(
                        {
                            host: this.hueBridgeHost,
                            port: this.hueBridgePort,
                            path,
                            method,
                            agent: this.bridgeAgent,
                            rejectUnauthorized: false,
                            headers,
                        },
                        res => {
                            let chunks = '';
                            res.on('data', c => (chunks += c));
                            res.on('end', () => {
                                const statusCode = res.statusCode || 0;
                                this.setBridgeReachable(statusCode < 500);
                                let parsed = null;
                                if (chunks) {
                                    try {
                                        parsed = JSON.parse(chunks);
                                    } catch {
                                        parsed = null;
                                    }
                                }
                                resolve({ statusCode, body: parsed, raw: chunks });
                            });
                        },
                    );
                    req.on('error', err => {
                        this.setBridgeReachable(false, true);
                        reject(err);
                    });
                    req.setTimeout(8000, () => {
                        this.setBridgeReachable(false);
                        req.destroy(new Error('Timeout'));
                    });
                    if (data) {
                        req.write(data);
                    }
                    req.end();
                }),
        );
    }

    async clipV2Request(method, resourcePath, body) {
        const res = await this.rawHttpsJson(method, `/clip/v2${resourcePath}`, body, true);
        const errors = res.body && Array.isArray(res.body.errors) ? res.body.errors : [];
        if (res.statusCode < 200 || res.statusCode >= 300 || errors.length > 0) {
            const msg =
                errors
                    .map(e => e.description)
                    .filter(Boolean)
                    .join('; ') || `HTTP ${res.statusCode}`;
            const err = new Error(`CLIP v2 ${method} ${resourcePath}: ${msg}`);
            err.statusCode = res.statusCode;
            throw err;
        }
        return (res.body && res.body.data) || [];
    }

    async deleteClipV2SceneSafe(sceneId) {
        if (!sceneId) {
            return;
        }
        try {
            await this.clipV2Request('DELETE', `/resource/scene/${sceneId}`);
        } catch {
            /* ignore if already gone */
        }
    }

    async cleanupLegacyV1Scenes() {
        try {
            const res = await this.rawHttpsJson('GET', `/api/${this.hueBridgeUser}/scenes`, undefined, false);
            if (res.statusCode < 200 || res.statusCode >= 300 || !res.body || typeof res.body !== 'object') {
                return;
            }
            // Only remove legacy CLIP v1 LightScenes ("lx_..."). CLIP v2 scenes appear as "GroupScene".
            const legacyIds = Object.keys(res.body).filter(id => {
                const entry = res.body[id];
                return (
                    entry &&
                    entry.type === 'LightScene' &&
                    typeof entry.name === 'string' &&
                    entry.name.startsWith('lx_')
                );
            });
            if (legacyIds.length === 0) {
                return;
            }
            let deleted = 0;
            for (const id of legacyIds) {
                try {
                    const delRes = await this.rawHttpsJson(
                        'DELETE',
                        `/api/${this.hueBridgeUser}/scenes/${id}`,
                        undefined,
                        false,
                    );
                    if (delRes.statusCode >= 200 && delRes.statusCode < 300) {
                        deleted++;
                    }
                } catch {
                    /* ignore individual delete failures */
                }
            }
            this.log.info(`[SZENE] ${deleted} verwaiste Legacy-v1 "lx_"-Szenen auf der Hue-Bridge bereinigt.`);
        } catch (e) {
            this.log.warn(`[SZENE] Bereinigung alter v1-Szenen übersprungen: ${e.message}`);
        }
    }

    getRoomBridgeLightIds(roomKey) {
        const room = this.roomGroups[roomKey];
        if (!room) {
            return [];
        }
        const ids = new Set();
        for (const member of room.members) {
            const cap = this.deviceCapabilities[member.hueId];
            if (!cap || cap.isGroup || !cap.bridgeId || /tradfri/i.test(member.hueId)) {
                continue;
            }
            const v2Light = this.v2LightsByV1Id.get(String(cap.bridgeId));
            if (v2Light) {
                ids.add(v2Light.id);
            }
        }
        return Array.from(ids).sort();
    }

    async ensureRoomV2Zone(roomKey, sortedLightIds, existingZonesByName) {
        if (sortedLightIds.length === 0) {
            return null;
        }
        const zoneName = sceneStateMachine.buildCacheZoneName(roomKey);
        const current = this.v2ZonesByRoom.get(roomKey);
        if (current && JSON.stringify(current.lightIds) === JSON.stringify(sortedLightIds)) {
            return current.id;
        }

        const desiredChildren = sortedLightIds.map(rid => ({ rid, rtype: 'light' }));
        const existingZone =
            current ||
            (existingZonesByName
                ? existingZonesByName.get(zoneName)
                : (await this.clipV2Request('GET', '/resource/zone')).find(
                      z => z.metadata && z.metadata.name === zoneName,
                  ));

        if (existingZone) {
            const existingIds =
                existingZone.lightIds ||
                (existingZone.children || [])
                    .filter(c => c.rtype === 'light')
                    .map(c => c.rid)
                    .sort();
            if (JSON.stringify(existingIds) !== JSON.stringify(sortedLightIds)) {
                await this.clipV2Request('PUT', `/resource/zone/${existingZone.id}`, { children: desiredChildren });
                this.log.info(`[SZENE] CLIP v2 Zone "${zoneName}" aktualisiert (${sortedLightIds.length} Lampen).`);
            }
            this.v2ZonesByRoom.set(roomKey, { id: existingZone.id, lightIds: sortedLightIds });
            return existingZone.id;
        }

        const created = await this.clipV2Request('POST', '/resource/zone', {
            type: 'zone',
            metadata: { name: zoneName, archetype: 'other' },
            children: desiredChildren,
        });
        const zoneId = extractRid(created);
        if (zoneId) {
            this.v2ZonesByRoom.set(roomKey, { id: zoneId, lightIds: sortedLightIds });
            this.log.info(`[SZENE] CLIP v2 Zone "${zoneName}" angelegt (${sortedLightIds.length} Lampen).`);
        }
        return zoneId;
    }

    async initClipV2Resources() {
        const [lights, zones] = await Promise.all([
            this.clipV2Request('GET', '/resource/light'),
            this.clipV2Request('GET', '/resource/zone'),
        ]);
        this.v2LightsByV1Id.clear();
        this.v2ZonesByRoom.clear();
        for (const l of lights) {
            if (!l.id_v1 || !l.id_v1.startsWith('/lights/')) {
                continue;
            }
            const schema = l.color_temperature && l.color_temperature.mirek_schema;
            this.v2LightsByV1Id.set(l.id_v1.slice('/lights/'.length), {
                id: l.id,
                minDimLevel: l.dimming && typeof l.dimming.min_dim_level === 'number' ? l.dimming.min_dim_level : 0.1,
                mirekMin: schema && typeof schema.mirek_minimum === 'number' ? schema.mirek_minimum : 153,
                mirekMax: schema && typeof schema.mirek_maximum === 'number' ? schema.mirek_maximum : 500,
                hasDimming: !!l.dimming,
                hasColor: !!l.color,
                hasCT: !!l.color_temperature,
            });
        }

        const zonesByName = new Map();
        const activeZoneNames = new Set();
        const minLights = this.config.sceneMinLights ?? 2;

        for (const z of zones) {
            const name = z.metadata && z.metadata.name;
            if (typeof name === 'string') {
                zonesByName.set(name, z);
            }
        }

        for (const roomKey of Object.keys(this.roomGroups)) {
            const lightIds = this.getRoomBridgeLightIds(roomKey);
            if (lightIds.length >= minLights) {
                activeZoneNames.add(sceneStateMachine.buildCacheZoneName(roomKey));
                await this.ensureRoomV2Zone(roomKey, lightIds, zonesByName);
            }
        }

        // Clean up deprecated single global cache zone and unused per-room cache zones
        for (const z of zones) {
            const name = z.metadata && z.metadata.name;
            if (
                name === LEGACY_CACHE_ZONE_NAME ||
                (typeof name === 'string' && name.startsWith(CACHE_ZONE_PREFIX) && !activeZoneNames.has(name))
            ) {
                try {
                    await this.clipV2Request('DELETE', `/resource/zone/${z.id}`);
                    this.log.info(`[SZENE] Ungenutzte CLIP v2 Zone "${name}" bereinigt.`);
                } catch {
                    /* ignore */
                }
            }
        }

        await this.reconcileV2Scenes();
    }

    async reconcileV2Scenes() {
        const v2Scenes = await this.clipV2Request('GET', '/resource/scene');
        const validSceneIds = new Set(v2Scenes.map(s => s.id));
        const managedZoneIds = new Set(Array.from(this.v2ZonesByRoom.values()).map(z => z.id));
        const referencedSceneIds = new Set();

        for (const roomCache of Object.values(this.sceneCache.rooms)) {
            if (!roomCache || typeof roomCache !== 'object') {
                continue;
            }
            for (const entry of Object.values(roomCache)) {
                if (!entry || entry.dynamic || !entry.bridgeSceneId) {
                    continue;
                }
                if (validSceneIds.has(entry.bridgeSceneId)) {
                    referencedSceneIds.add(entry.bridgeSceneId);
                } else {
                    delete entry.bridgeSceneId;
                    this.saveSceneCacheDebounced();
                }
            }
        }

        const orphans = v2Scenes.filter(
            s =>
                s.group &&
                managedZoneIds.has(s.group.rid) &&
                s.metadata &&
                typeof s.metadata.name === 'string' &&
                s.metadata.name.startsWith('lx_') &&
                !referencedSceneIds.has(s.id),
        );
        for (const s of orphans) {
            await this.deleteClipV2SceneSafe(s.id);
        }
        if (orphans.length > 0) {
            this.log.info(`[SZENE] ${orphans.length} verwaiste CLIP v2 Cache-Szenen bereinigt.`);
        }
    }

    // ---------------------------------------------------------------
    // Device detection & command execution
    // ---------------------------------------------------------------
    async detectDevice(hueId, loxoneBaseId) {
        if (this.deviceCapabilities[hueId]) {
            return this.deviceCapabilities[hueId];
        }

        const isGroup = await this.stateExists(`${hueId}.action.on`);
        const cmdPrefix = isGroup ? '.action' : '';

        const [hasXyState, hasHueState, hasCT, hasLevel, hasOn, hueObj] = await Promise.all([
            this.stateExists(`${hueId + cmdPrefix}.xy`),
            this.stateExists(`${hueId + cmdPrefix}.hue`),
            this.stateExists(`${hueId + cmdPrefix}.ct`),
            this.stateExists(`${hueId + cmdPrefix}.level`),
            this.stateExists(`${hueId + cmdPrefix}.on`),
            this.getForeignObjectAsync(hueId),
        ]);

        const isRGB = hasXyState || hasHueState;
        const isDimmer = hasLevel;
        let loxoneSuffix = '.active';
        if (isRGB) {
            loxoneSuffix = '.rgb';
        } else if (isDimmer) {
            const loxObj = loxoneBaseId ? await this.getForeignObjectAsync(loxoneBaseId) : null;
            const controlType = loxObj && loxObj.native && loxObj.native.control && loxObj.native.control.type;
            loxoneSuffix = /color/i.test(controlType || '') ? '.rgb' : '.position';
        }

        const type = {
            isGroup,
            cmdPrefix,
            isRGB,
            hasCT,
            isDimmer,
            isSwitch: hasOn && !isDimmer,
            loxoneSuffix,
            fullLoxoneId: loxoneBaseId ? loxoneBaseId + loxoneSuffix : null,
            bridgeId: (hueObj && hueObj.native && hueObj.native.id) || null,
        };

        this.deviceCapabilities[hueId] = type;
        if (hasOn) {
            const initOn = await this.getForeignVal(`${hueId + cmdPrefix}.on`);
            if (typeof initOn === 'boolean') {
                this.lastKnownOn.set(hueId, initOn);
            }
        }
        const label = capabilityLabel(type);
        if (label === 'Unknown') {
            this.log.warn(
                `[${hueId}] keine Fähigkeiten erkannt (.on/.level/.xy/.hue fehlen alle) - Hue-Objekt-ID prüfen, existiert die Lampe noch?`,
            );
        }
        this.log.debug(
            `[INIT] ${hueId} (${isGroup ? 'GRUPPE' : 'LAMPE'}), Typ ${label}, lauscht auf ${type.loxoneSuffix}`,
        );
        return type;
    }

    computeCommandRaw(inputVal, hueId, wasOnOverride) {
        const type = this.deviceCapabilities[hueId];
        if (!type) {
            return null;
        }
        return commandLogic.computeRawCommand({
            inputVal,
            type,
            isTradfri: /tradfri/i.test(hueId),
            wasOn: typeof wasOnOverride === 'boolean' ? wasOnOverride : this.lastKnownOn.get(hueId) === true,
            config: {
                offFadeMs: this.config.offFadeMs,
                onFadeMs: this.config.onFadeMs,
                rgbBrightnessFactor: this.config.rgbBrightnessFactor,
                forceWarmWhiteMired: this.config.forceWarmWhiteMired,
            },
        });
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
            const cmd = this.computeCommandRaw(inputVal, hueId);
            if (cmd) {
                this.lastKnownOn.set(hueId, !cmd.isOff);
            }
            await this.applyCommand(hueId, type.cmdPrefix, cmd);
        } catch (e) {
            this.log.error(`[${hueId}] ${e.message}`);
        }
    }

    // ---------------------------------------------------------------
    // Debounce/batch
    // ---------------------------------------------------------------
    scheduleAction(loxoneId, hueId, val) {
        this.pendingChanges.set(hueId, { loxoneId, hueId, val });
        if (!this.debounceTimer) {
            this.debounceTimer = this.setTimeout(
                () => this.executeBatch().catch(e => this.log.error(`[BATCH] ${e.message}`)),
                this.config.debounceMs ?? 200,
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
        await Promise.all(changes.map(c => this.controlHueDevice(c.val, c.hueId)));
    }

    // ---------------------------------------------------------------
    // Rooms & CLIP v2 scene cache
    // ---------------------------------------------------------------
    getOrCreateRoom(roomKey) {
        if (!this.roomGroups[roomKey]) {
            this.roomGroups[roomKey] = {
                members: [],
                activeMoodsId: undefined,
                currentMoodNum: undefined,
                currentMoodSince: Date.now(),
                burstStartAt: null,
                burstEvents: 0,
                lastWaveAt: 0,
                settleTimer: null,
                recalledMoodNum: null,
                recalledUntil: 0,
                lastTransitionAt: 0,
            };
        }
        return this.roomGroups[roomKey];
    }

    getCachedMood(roomKey, moodNum) {
        if (!sceneStateMachine.isValidStaticMood(moodNum)) {
            return null;
        }
        const roomCache = this.sceneCache.rooms[roomKey];
        return roomCache ? roomCache[sceneStateMachine.normalizeMoodKey(moodNum)] || null : null;
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
        let needsReset = false;
        try {
            const parsed = JSON.parse((state && state.val) || '{}');
            if (parsed && parsed.version === CACHE_SCHEMA_VERSION && parsed.rooms && typeof parsed.rooms === 'object') {
                this.sceneCache = parsed;
            } else {
                needsReset = !!(parsed && Object.keys(parsed).length > 0);
                this.sceneCache = { version: CACHE_SCHEMA_VERSION, rooms: {} };
            }
        } catch {
            this.sceneCache = { version: CACHE_SCHEMA_VERSION, rooms: {} };
        }
        if (needsReset) {
            this.log.info(
                '[SZENE] Szenen-Cache auf Schema v2 (CLIP v2, bereinigte Lernlogik) zurückgesetzt — Szenen werden sauber neu gelernt.',
            );
            await this.setStateAsync(id, JSON.stringify(this.sceneCache), true);
        }
    }

    flushDirtySceneCache() {
        if (!this.cacheDirty) {
            return;
        }
        this.cacheDirty = false;
        this.setState('cache.szenen', JSON.stringify(this.sceneCache), true);
    }

    saveSceneCacheDebounced() {
        this.cacheDirty = true;
        this.clearTimer(this, 'cacheSaveTimer');
        this.cacheSaveTimer = this.setTimeout(() => {
            this.cacheSaveTimer = null;
            this.flushDirtySceneCache();
        }, 2000);
    }

    scheduleSettleCheck(roomKey) {
        const room = this.roomGroups[roomKey];
        if (!room || !room.activeMoodsId) {
            return;
        }
        this.clearTimer(room, 'settleTimer');
        room.settleTimer = this.setTimeout(
            () => this.snapshotRoom(roomKey).catch(e => this.log.error(`[SZENE] ${e.message}`)),
            this.config.settleMs ?? 8000,
        );
    }

    async markDynamic(roomKey, moodKey) {
        const roomCache = (this.sceneCache.rooms[roomKey] ||= {});
        const existing = roomCache[moodKey];
        if (existing && existing.dynamic) {
            return;
        }
        if (existing) {
            await this.deleteClipV2SceneSafe(existing.bridgeSceneId);
        }
        roomCache[moodKey] = { dynamic: true };
        this.saveSceneCacheDebounced();
        this.log.info(
            `[SZENE] ${roomKey} Mood ${moodKey} ändert sich dauerhaft (> ${
                (this.config.dynamicGiveUpMs ?? 30000) / 1000
            }s ohne Pause) -> als dynamisch markiert.`,
        );
    }

    buildClipV2Actions(snap) {
        const actions = [];
        for (const hueId of Object.keys(snap)) {
            const type = this.deviceCapabilities[hueId];
            const v2Light = type && !type.isGroup && type.bridgeId && this.v2LightsByV1Id.get(String(type.bridgeId));
            const action = v2Light && commandLogic.commandToClipV2Action(snap[hueId], v2Light);
            if (action) {
                actions.push({ target: { rid: v2Light.id, rtype: 'light' }, action });
            }
        }
        return actions;
    }

    async upsertBridgeScene(roomKey, moodKey, snap, existingEntry) {
        const actions = this.buildClipV2Actions(snap);
        if (actions.length < (this.config.sceneMinLights ?? 2)) {
            if (existingEntry) {
                await this.deleteClipV2SceneSafe(existingEntry.bridgeSceneId);
            }
            return null;
        }

        const actionLightIds = actions.map(a => a.target.rid).sort();
        const zoneId = await this.ensureRoomV2Zone(roomKey, actionLightIds);
        if (!zoneId) {
            return null;
        }

        const sceneName = sceneStateMachine.buildBridgeSceneName(roomKey, moodKey);
        if (existingEntry && existingEntry.bridgeSceneId) {
            try {
                await this.clipV2Request('PUT', `/resource/scene/${existingEntry.bridgeSceneId}`, {
                    metadata: { name: sceneName },
                    actions,
                });
                this.log.info(
                    `[SZENE] CLIP v2 Bridge-Szene für ${roomKey}/${moodKey} aktualisiert (${existingEntry.bridgeSceneId}, ${actions.length} Lampen).`,
                );
                return existingEntry.bridgeSceneId;
            } catch (e) {
                this.log.debug(
                    `[SZENE] In-place-Update für ${existingEntry.bridgeSceneId} fehlgeschlagen (${e.message}), lege neu an.`,
                );
            }
        }

        try {
            const created = await this.clipV2Request('POST', '/resource/scene', {
                type: 'scene',
                metadata: { name: sceneName },
                group: { rid: zoneId, rtype: 'zone' },
                auto_dynamic: false,
                actions,
            });
            const sceneId = extractRid(created);
            if (!sceneId) {
                this.log.error(`[SZENE] CLIP v2 Bridge-Szene für ${roomKey}/${moodKey} lieferte keine ID.`);
                return null;
            }
            this.log.info(
                `[SZENE] CLIP v2 Bridge-Szene für ${roomKey}/${moodKey} angelegt (${sceneId}, ${actions.length} Lampen).`,
            );
            return sceneId;
        } catch (e) {
            // If POST timed out after bridge creation, recover existing scene by name in zone
            try {
                const v2Scenes = await this.clipV2Request('GET', '/resource/scene');
                const existing = v2Scenes.find(
                    s => s.group && s.group.rid === zoneId && s.metadata && s.metadata.name === sceneName,
                );
                if (existing) {
                    await this.clipV2Request('PUT', `/resource/scene/${existing.id}`, { actions });
                    this.log.info(
                        `[SZENE] CLIP v2 Bridge-Szene für ${roomKey}/${moodKey} nach Lookup übernommen (${existing.id}, ${actions.length} Lampen).`,
                    );
                    return existing.id;
                }
            } catch {
                /* keep original error below */
            }
            this.log.error(`[SZENE] CLIP v2 Bridge-Szene für ${roomKey}/${moodKey} fehlgeschlagen: ${e.message}`);
            return null;
        }
    }

    async snapshotRoom(roomKey) {
        const room = this.roomGroups[roomKey];
        if (!room) {
            return;
        }
        sceneStateMachine.markSettled(room);
        room.settleTimer = null;

        if (!room.activeMoodsId || !(await this.stateExists(room.activeMoodsId))) {
            return;
        }
        const rawMood = await this.getForeignVal(room.activeMoodsId);
        if (!sceneStateMachine.isValidStaticMood(rawMood)) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${rawMood} = nicht statisch -> wird nicht gecacht.`);
            return;
        }
        const moodKey = sceneStateMachine.normalizeMoodKey(rawMood);
        room.currentMoodNum = moodKey;

        const existingEntry = this.sceneCache.rooms[roomKey] && this.sceneCache.rooms[roomKey][moodKey];
        if (existingEntry && existingEntry.dynamic) {
            return;
        }

        const snap = {};
        await Promise.all(
            room.members.map(async member => {
                const type = this.deviceCapabilities[member.hueId];
                if (!type || !type.fullLoxoneId || !(await this.stateExists(type.fullLoxoneId))) {
                    return;
                }
                const val = await this.getForeignVal(type.fullLoxoneId);
                // Deterministic snapshot with wasOn=false so CT defaults persist across transitions
                const cmd = this.computeCommandRaw(val, member.hueId, false);
                if (cmd) {
                    snap[member.hueId] = cmd;
                }
            }),
        );

        const fingerprint = commandLogic.snapshotFingerprint(snap);
        const needsBridgeScene = this.buildClipV2Actions(snap).length >= (this.config.sceneMinLights ?? 2);

        if (
            existingEntry &&
            existingEntry.fingerprint === fingerprint &&
            (!needsBridgeScene || existingEntry.bridgeSceneId)
        ) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodKey} unverändert -> Bridge-Szene bleibt bestehen.`);
            return;
        }

        const bridgeSceneId = await this.upsertBridgeScene(roomKey, moodKey, snap, existingEntry);
        (this.sceneCache.rooms[roomKey] ||= {})[moodKey] = {
            lights: snap,
            fingerprint,
            bridgeSceneId: bridgeSceneId || undefined,
        };
        this.saveSceneCacheDebounced();
        this.log.info(
            `[SZENE] ${roomKey} Mood ${moodKey} eingeschwungen, ${Object.keys(snap).length} Lampen gespeichert${
                bridgeSceneId ? ` (+ CLIP v2 Szene ${bridgeSceneId})` : ''
            }.`,
        );
    }

    async applyIndividually(lightsMap) {
        await Promise.all(
            Object.entries(lightsMap).map(async ([hueId, cmd]) => {
                const type = this.deviceCapabilities[hueId];
                if (!type || !cmd) {
                    return;
                }
                this.lastKnownOn.set(hueId, !cmd.isOff);
                await this.applyCommand(hueId, type.cmdPrefix, cmd);
            }),
        );
    }

    async applySceneImmediately(roomKey, moodNum, now) {
        const entry = this.getCachedMood(roomKey, moodNum);
        if (!entry) {
            return;
        }
        const moodKey = sceneStateMachine.normalizeMoodKey(moodNum);
        if (entry.dynamic) {
            this.log.debug(`[SZENE] ${roomKey} Mood ${moodKey} ist dynamisch -> normaler Ablauf.`);
            return;
        }
        if (!entry.bridgeSceneId) {
            return;
        }

        const room = this.roomGroups[roomKey];
        const lightsMap = entry.lights || {};

        for (const member of room.members) {
            const pending = this.pendingChanges.get(member.hueId);
            const expected = pending && lightsMap[member.hueId];
            if (!expected) {
                continue;
            }
            const pendingCmd = this.computeCommandRaw(pending.val, member.hueId, false);
            if (pendingCmd && commandLogic.commandSignature(pendingCmd) === commandLogic.commandSignature(expected)) {
                this.pendingChanges.delete(member.hueId);
            }
        }
        room.recalledMoodNum = moodKey;
        room.recalledUntil = now + RECALL_SUPPRESS_MS;

        const lightEntries = Object.entries(lightsMap);
        for (const [hueId, cmd] of lightEntries) {
            this.lastKnownOn.set(hueId, !cmd.isOff);
        }

        const allOff = lightEntries.length > 0 && lightEntries.every(([, cmd]) => cmd.isOff);
        const duration = allOff ? (this.config.offFadeMs ?? 700) : (this.config.onFadeMs ?? 700);

        this.log.info(
            `[SZENE] ${roomKey} Mood ${moodKey} bekannt -> CLIP v2 Szene ${entry.bridgeSceneId} abrufen (1 Aufruf statt ${lightEntries.length}, duration ${duration}ms).`,
        );
        try {
            await this.clipV2Request('PUT', `/resource/scene/${entry.bridgeSceneId}`, {
                recall: { action: 'active', duration },
            });
            await Promise.all(
                lightEntries
                    .filter(([, cmd]) => cmd && cmd.groupable === false)
                    .map(([hueId, cmd]) => {
                        const type = this.deviceCapabilities[hueId];
                        return type ? this.applyCommand(hueId, type.cmdPrefix, cmd) : null;
                    }),
            );
        } catch (e) {
            this.log.warn(`[SZENE] CLIP v2 Szenen-Abruf fehlgeschlagen (${e.message}) -> Einzelbefehle als Rückfall.`);
            if (e.statusCode === 404) {
                delete entry.bridgeSceneId;
                this.saveSceneCacheDebounced();
            }
            await this.applyIndividually(lightsMap);
        }
    }

    // ---------------------------------------------------------------
    // Off watchdog
    // ---------------------------------------------------------------
    async forceTurnOffDevice(hueId, type, cmd) {
        const v2Light = !type.isGroup && type.bridgeId && this.v2LightsByV1Id.get(String(type.bridgeId));
        if (v2Light) {
            try {
                await this.clipV2Request('PUT', `/resource/light/${v2Light.id}`, { on: { on: false } });
                return;
            } catch (e) {
                this.log.warn(`[WÄCHTER] CLIP v2 Aus für ${hueId} fehlgeschlagen (${e.message}), nutze Fallback.`);
            }
        }
        const onStateId = `${hueId + type.cmdPrefix}.on`;
        if (await this.stateExists(onStateId)) {
            await this.setForeignStateAsync(onStateId, false, false);
            return;
        }
        await this.applyCommand(hueId, type.cmdPrefix, cmd);
    }

    async checkAndCorrectOff() {
        let checked = 0;
        let corrected = 0;
        const now = Date.now();
        const members = Object.values(this.roomGroups)
            .filter(r => !r.lastTransitionAt || now - r.lastTransitionAt >= WATCHDOG_GRACE_MS)
            .flatMap(r => r.members);

        await Promise.all(
            members.map(async ({ hueId }) => {
                try {
                    const type = this.deviceCapabilities[hueId];
                    if (!type || !type.fullLoxoneId || !(await this.stateExists(type.fullLoxoneId))) {
                        return;
                    }
                    const cmd = this.computeCommandRaw(await this.getForeignVal(type.fullLoxoneId), hueId);
                    const onStateId = `${hueId + type.cmdPrefix}.on`;
                    if (!cmd || !cmd.isOff || !(await this.stateExists(onStateId))) {
                        return;
                    }
                    checked++;
                    if ((await this.getForeignVal(onStateId)) !== true) {
                        return;
                    }
                    corrected++;
                    this.lastKnownOn.set(hueId, false);
                    const reachableId = `${hueId}.reachable`;
                    const reachable = (await this.stateExists(reachableId))
                        ? await this.getForeignVal(reachableId)
                        : null;
                    this.log.info(
                        `[WÄCHTER] ${hueId} sollte aus sein, ist aber noch an${
                            reachable === false ? ' (nicht erreichbar!)' : ''
                        } -> sende Aus erneut.`,
                    );
                    await this.forceTurnOffDevice(hueId, type, cmd);
                } catch (e) {
                    this.log.warn(`[WÄCHTER] ${hueId}: ${e.message}`);
                }
            }),
        );

        if (corrected > 0) {
            this.log.info(`[WÄCHTER] ${corrected} von ${checked} geprüften "Aus"-Lampen mussten korrigiert werden.`);
        }
    }

    // ---------------------------------------------------------------
    // Admin UI Loxone context helper
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
                const baseLoxoneId = stripLoxoneSuffix(d.loxoneId);
                let type = this.deviceCapabilities[d.hueId];
                if (!type && !onlyKnownDevices) {
                    try {
                        type = await this.detectDevice(d.hueId, baseLoxoneId);
                    } catch {
                        /* Hue device possibly unreachable */
                    }
                }
                if (!type) {
                    return;
                }
                const loxObj = await this.getForeignObjectAsync(baseLoxoneId);
                const loxoneName = (loxObj && loxObj.common && loxObj.common.name) || baseLoxoneId;
                const group = d.loxoneInfo && d.loxoneInfo.includes('::') ? d.loxoneInfo.split('::')[0] : d.group || '';
                const newContext = `${group}::${loxoneName} (Type ${capabilityLabel(type)})`;
                if (d.loxoneInfo !== newContext) {
                    d.loxoneInfo = newContext;
                    changed++;
                }
            }),
        );
        if (changed > 0) {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { devices } });
            this.log.debug(`[KONTEXT] ${changed} von ${total} Einträgen aktualisiert.`);
        }
        return { changed, total };
    }

    async onMessage(obj) {
        if (obj.command !== 'refreshLoxoneContext') {
            return;
        }
        try {
            const selfObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            const devices = (selfObj && selfObj.native && selfObj.native.devices) || [];
            const result = await this.updateLoxoneContext(devices, false);
            if (obj.callback) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    { native: { devices }, message: `${result.changed} von ${result.total} Einträgen aktualisiert.` },
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

    // ---------------------------------------------------------------
    // Startup, events & shutdown
    // ---------------------------------------------------------------
    async onReady() {
        this.setState('info.connection', false, true);

        const rawDevices = this.config.devices || [];
        if (!rawDevices.length) {
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

        const devices = rawDevices
            .filter(d => d.loxoneId && d.hueId)
            .map(d => ({ ...d, loxoneId: stripLoxoneSuffix(d.loxoneId) }));

        await Promise.all(
            devices.map(async d => {
                const roomKey = loxoneRoomKey(d.loxoneId);
                this.getOrCreateRoom(roomKey).members.push(d);
                const type = await this.detectDevice(d.hueId, d.loxoneId);
                if (!this.loxoneToHue.has(type.fullLoxoneId)) {
                    this.loxoneToHue.set(type.fullLoxoneId, []);
                }
                this.loxoneToHue.get(type.fullLoxoneId).push({ roomKey, hueId: d.hueId });
                await this.subscribeForeignStatesAsync(type.fullLoxoneId);
            }),
        );

        await this.updateLoxoneContext(rawDevices, true);

        try {
            await this.cleanupLegacyV1Scenes();
            await this.initClipV2Resources();
        } catch (e) {
            this.log.error(`[SZENE] CLIP v2 Initialisierung fehlgeschlagen: ${e.message}`);
        }

        await Promise.all(
            Object.entries(this.roomGroups).map(async ([roomKey, room]) => {
                const activeMoodsId = `${roomKey}.activeMoodsNum`;
                if (!(await this.stateExists(activeMoodsId))) {
                    return;
                }
                room.activeMoodsId = activeMoodsId;
                room.currentMoodNum = sceneStateMachine.formatMoodState(await this.getForeignVal(activeMoodsId));
                room.currentMoodSince = Date.now();
                this.activeMoodsToRoom.set(activeMoodsId, roomKey);
                await this.subscribeForeignStatesAsync(activeMoodsId);
                this.log.info(`[SZENE] ${roomKey}: Lichtsteuerungsbaustein erkannt, ${room.members.length} Lampen.`);
            }),
        );

        const watchdogMin = this.config.watchdogIntervalMin ?? 5;
        if (watchdogMin > 0) {
            this.watchdogInterval = this.setInterval(
                () => this.checkAndCorrectOff().catch(e => this.log.warn(`[WÄCHTER] ${e.message}`)),
                watchdogMin * 60000,
            );
        }

        this.setBridgeReachable(true);
        this.log.info(
            `lox2hue bereit (CLIP v2): ${devices.length} Geräte in ${Object.keys(this.roomGroups).length} Räumen.`,
        );
    }

    onMoodStateChange(roomKey, val, now) {
        const room = this.roomGroups[roomKey];
        room.lastTransitionAt = now;
        this.clearTimer(room, 'settleTimer');
        const res = sceneStateMachine.handleMoodChange(room, val, now);
        if (!res.isStatic) {
            return;
        }
        const cachedEntry = this.getCachedMood(roomKey, res.moodKey);
        this.applySceneImmediately(roomKey, res.moodKey, now).catch(e => this.log.error(e.message));
        if (!cachedEntry || !cachedEntry.dynamic) {
            this.scheduleSettleCheck(roomKey);
        }
    }

    onDeviceStateChange(id, val, now) {
        const targets = this.loxoneToHue.get(id);
        if (!targets) {
            return;
        }
        const touchedRooms = new Set();
        for (const target of targets) {
            const room = this.roomGroups[target.roomKey];
            const cachedEntry = room ? this.getCachedMood(target.roomKey, room.currentMoodNum) : null;
            const incomingCmd = this.computeCommandRaw(val, target.hueId, false);
            if (
                sceneStateMachine.shouldSuppressEcho({
                    room,
                    hueId: target.hueId,
                    incomingCmd,
                    cachedEntry,
                    now,
                    commandSignatureFn: commandLogic.commandSignature,
                })
            ) {
                if (incomingCmd) {
                    this.lastKnownOn.set(target.hueId, !incomingCmd.isOff);
                }
                continue;
            }
            this.scheduleAction(id, target.hueId, val);
            touchedRooms.add(target.roomKey);
        }

        for (const rk of touchedRooms) {
            const room = this.roomGroups[rk];
            if (room) {
                room.lastTransitionAt = now;
            }
            const cachedEntry = room ? this.getCachedMood(rk, room.currentMoodNum) : null;
            if (!room || (cachedEntry && cachedEntry.dynamic)) {
                continue;
            }
            const res = sceneStateMachine.handleLampChange(room, now, {
                dynamicGiveUpMs: this.config.dynamicGiveUpMs ?? 30000,
            });
            if (res.isDynamic && res.moodKey) {
                this.clearTimer(room, 'settleTimer');
                this.markDynamic(rk, res.moodKey).catch(e => this.log.error(e.message));
            } else if (res.scheduleSettle) {
                this.scheduleSettleCheck(rk);
            }
        }
    }

    onStateChange(id, state) {
        if (!state) {
            return;
        }
        const now = Date.now();
        const roomKey = this.activeMoodsToRoom.get(id);
        if (roomKey) {
            this.onMoodStateChange(roomKey, state.val, now);
        } else {
            this.onDeviceStateChange(id, state.val, now);
        }
    }

    onUnload(callback) {
        try {
            this.clearTimer(this, 'debounceTimer');
            this.clearTimer(this, 'cacheSaveTimer');
            this.flushDirtySceneCache();
            if (this.watchdogInterval) {
                this.clearInterval(this.watchdogInterval);
                this.watchdogInterval = null;
            }
            for (const room of Object.values(this.roomGroups)) {
                this.clearTimer(room, 'settleTimer');
            }
            if (this.bridgeAgent) {
                this.bridgeAgent.destroy();
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

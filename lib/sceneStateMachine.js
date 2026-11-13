'use strict';

/**
 * Checks whether a Loxone mood value represents a valid cacheable static mood (>= 0).
 *
 * @param {string|number|undefined|null} moodNum Raw activeMoodsNum value
 * @returns {boolean} True when moodNum is a finite number >= 0
 */
function isValidStaticMood(moodNum) {
    if (moodNum === undefined || moodNum === null || moodNum === '') {
        return false;
    }
    const n = Number(moodNum);
    return Number.isFinite(n) && n >= 0;
}

/**
 * Normalizes a valid mood value to its canonical string key (e.g. "1", "778").
 *
 * @param {string|number} moodNum Mood value
 * @returns {string} Trimmed numeric string
 */
function normalizeMoodKey(moodNum) {
    return String(Number(moodNum));
}

/**
 * Formats an initial/unknown raw mood value without throwing or misclassifying nulls.
 *
 * @param {string|number|undefined|null} moodNum Raw mood value
 * @returns {string|undefined} Normalized mood string or undefined
 */
function formatMoodState(moodNum) {
    if (isValidStaticMood(moodNum)) {
        return normalizeMoodKey(moodNum);
    }
    return moodNum !== undefined && moodNum !== null ? String(moodNum) : undefined;
}

/**
 * Extracts the leading 12 hex chars of a Loxone block UUID (which differ per block,
 * whereas trailing suffixes such as "-ffff7dd9eafbeece" are often shared across blocks).
 *
 * @param {string} roomKey Loxone control base ID
 * @returns {string} Compact block identifier
 */
function compactBlockId(roomKey) {
    const rawBlock =
        String(roomKey || '')
            .split('.')
            .pop() || 'room';
    return rawBlock.replace(/-/g, '').slice(0, 12);
}

/**
 * Builds a collision-free CLIP v2 scene name (max 32 chars) from leading block UUID hex chars.
 *
 * @param {string} roomKey Loxone control base ID
 * @param {string|number} moodNum Mood key
 * @returns {string} Scene name <= 32 characters
 */
function buildBridgeSceneName(roomKey, moodNum) {
    return `lx_${compactBlockId(roomKey)}_${moodNum}`.slice(0, 32);
}

/**
 * Builds the deterministic CLIP v2 cache-zone name (max 32 chars) for a Loxone room block.
 * Each room needs its own zone because Hue CLIP v2 requires scene actions to match every
 * light in the referenced group/zone.
 *
 * @param {string} roomKey Loxone control base ID
 * @returns {string} Zone name <= 32 characters
 */
function buildCacheZoneName(roomKey) {
    return `lox2hue: ${compactBlockId(roomKey)}`.slice(0, 32);
}

function setBurstState(room, startAt, now) {
    const active = startAt !== null;
    room.burstStartAt = startAt;
    room.burstEvents = active ? 1 : 0;
    room.lastWaveAt = active ? now : 0;
}

/**
 * Transitions room state when activeMoodsNum changes (mitigates pre-mood race condition).
 *
 * @param {object} room Mutable room state object
 * @param {string|number} newMoodNum Incoming activeMoodsNum value
 * @param {number} now Current epoch timestamp in ms
 * @returns {{ moodKey: string|null, isStatic: boolean, scheduleSettle: boolean }} Mood transition result
 */
function handleMoodChange(room, newMoodNum, now) {
    const staticMood = isValidStaticMood(newMoodNum);
    const moodKey = staticMood ? normalizeMoodKey(newMoodNum) : null;

    room.currentMoodNum = moodKey ?? formatMoodState(newMoodNum);
    room.currentMoodSince = now;
    setBurstState(room, staticMood ? now : null, now);
    room.recalledMoodNum = null;
    room.recalledUntil = 0;

    return { moodKey, isStatic: staticMood, scheduleSettle: staticMood };
}

/**
 * Updates burst/dynamic detection when a Loxone lamp state changes in a room.
 * Only marks a mood as dynamic after sustained change waves exceeding dynamicGiveUpMs.
 *
 * @param {object} room Mutable room state object
 * @param {number} now Current epoch timestamp in ms
 * @param {object} [options] Timing thresholds
 * @param {number} [options.dynamicGiveUpMs] Continuous burst threshold before giving up (default 30000)
 * @param {number} [options.waveGapMs] Minimum gap between events to count as a new change wave (default 250)
 * @param {number} [options.minDynamicWaves] Minimum distinct change waves required before marking dynamic (default 4)
 * @returns {{ isDynamic: boolean, moodKey: string|null, scheduleSettle: boolean }} Dynamic detection result
 */
function handleLampChange(room, now, options = {}) {
    if (!isValidStaticMood(room.currentMoodNum)) {
        setBurstState(room, null, 0);
        return { isDynamic: false, moodKey: null, scheduleSettle: false };
    }

    const dynamicGiveUpMs = options.dynamicGiveUpMs ?? 30000;
    const waveGapMs = options.waveGapMs ?? 250;
    const minDynamicWaves = options.minDynamicWaves ?? 4;
    const moodKey = normalizeMoodKey(room.currentMoodNum);

    if (room.burstStartAt === null || room.burstStartAt === undefined) {
        setBurstState(room, now, now);
        return { isDynamic: false, moodKey, scheduleSettle: true };
    }

    if (now - (room.lastWaveAt || 0) >= waveGapMs) {
        room.burstEvents = (room.burstEvents || 0) + 1;
        room.lastWaveAt = now;
    }

    const burstElapsed = now - room.burstStartAt;
    const moodElapsed = now - (room.currentMoodSince || now);
    if (burstElapsed > dynamicGiveUpMs && moodElapsed > dynamicGiveUpMs && room.burstEvents >= minDynamicWaves) {
        setBurstState(room, null, 0);
        return { isDynamic: true, moodKey, scheduleSettle: false };
    }

    return { isDynamic: false, moodKey, scheduleSettle: true };
}

/**
 * Resets burst tracking once a room settles (or is cleared).
 *
 * @param {object} room Mutable room state object
 */
function markSettled(room) {
    room.burstStartAt = null;
    room.burstEvents = 0;
}

/**
 * Determines whether an incoming Loxone lamp update during a cached scene recall window
 * matches what the recalled Hue bridge scene already applies.
 *
 * @param {object} params Input parameters
 * @param {object} params.room Room state
 * @param {string} params.hueId Target Hue object ID
 * @param {object|null} params.incomingCmd Computed command for the incoming Loxone value
 * @param {object|null} params.cachedEntry Cached scene entry for the active mood
 * @param {number} params.now Current epoch timestamp in ms
 * @param {(cmd: object) => string} params.commandSignatureFn Canonical signature function
 * @returns {boolean} True if this individual write should be suppressed
 */
function shouldSuppressEcho({ room, hueId, incomingCmd, cachedEntry, now, commandSignatureFn }) {
    if (!room || !cachedEntry || !cachedEntry.bridgeSceneId || !cachedEntry.lights) {
        return false;
    }
    if (!room.recalledUntil || now > room.recalledUntil) {
        return false;
    }
    if (!isValidStaticMood(room.currentMoodNum) || normalizeMoodKey(room.currentMoodNum) !== room.recalledMoodNum) {
        return false;
    }
    const expectedCmd = cachedEntry.lights[hueId];
    return !!(expectedCmd && incomingCmd && commandSignatureFn(incomingCmd) === commandSignatureFn(expectedCmd));
}

module.exports = {
    isValidStaticMood,
    normalizeMoodKey,
    formatMoodState,
    buildBridgeSceneName,
    buildCacheZoneName,
    handleMoodChange,
    handleLampChange,
    markSettled,
    shouldSuppressEcho,
};

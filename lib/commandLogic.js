'use strict';

const colorMath = require('./colorMath');

/**
 * Clamp a number to [min, max], returning fallback if non-finite.
 *
 * @param {number} val Input value
 * @param {number} min Minimum allowed
 * @param {number} max Maximum allowed
 * @param {number} [fallback] Fallback if val is NaN/Infinity
 * @returns {number} Clamped value
 */
function clampNumber(val, min, max, fallback = min) {
    const n = Number(val);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Parses an iobroker.loxone ".rgb" string ("r,g,b[,w]", 0-255 per channel) into a clamped RGB tuple.
 *
 * @param {string} rgbString Loxone "r,g,b[,w]" string, each channel 0-255
 * @returns {[number, number, number]} [r, g, b] in the 0-255 range
 */
function parseLoxoneRgb(rgbString) {
    const parts = String(rgbString).split(',', 3);
    return [0, 1, 2].map(i => clampNumber(Math.round(parseFloat((parts[i] || '').trim() || '0')), 0, 255, 0));
}

/**
 * Extracts and parses a `.command` JSON payload write from a command descriptor.
 *
 * @param {object|null} cmd Command descriptor
 * @returns {object|null} Parsed JSON command payload, or null if absent/invalid
 */
function parseJsonCommandWrite(cmd) {
    const cmdWrite = cmd && cmd.writes && cmd.writes.find(w => w.suffix === '.command');
    if (!cmdWrite) {
        return null;
    }
    try {
        return JSON.parse(cmdWrite.value);
    } catch {
        return null;
    }
}

/**
 * Pure decision logic: translates a Loxone input value and device capabilities into Hue writes.
 *
 * @param {object} params All inputs needed to decide the command
 * @param {string|number|boolean} params.inputVal Raw value read from the subscribed Loxone state
 * @param {object} params.type Device capabilities as produced by detectDevice() in main.js
 * @param {boolean} params.isTradfri Whether this Hue device is a Tradfri lamp
 * @param {boolean} params.wasOn Whether this lamp was on before this command
 * @param {object} params.config `{ offFadeMs, onFadeMs, rgbBrightnessFactor, forceWarmWhiteMired }`
 * @returns {object|null} Raw command descriptor, or null if unsupported device type
 */
function computeRawCommand({ inputVal, type, isTradfri, wasOn, config }) {
    const offFade = Math.round(clampNumber(config.offFadeMs ?? 700, 0, 600000, 700) / 100);
    const onFade = Math.round(clampNumber(config.onFadeMs ?? 700, 0, 600000, 700) / 100);
    const rgbFactor = clampNumber(config.rgbBrightnessFactor ?? 1, 0.01, 1, 1);

    const isRgbStr = typeof inputVal === 'string' && inputVal.includes(',');
    const rgb = isRgbStr ? parseLoxoneRgb(inputVal) : null;
    const maxRgb = rgb ? Math.max(...rgb) : 0;

    let brightnessPercent;
    let switchState = false;
    if (rgb) {
        brightnessPercent = clampNumber(Math.round((maxRgb / 255) * 100), 0, 100, 0);
    } else if (typeof inputVal === 'boolean') {
        switchState = inputVal;
        brightnessPercent = inputVal ? 100 : 0;
    } else {
        brightnessPercent = clampNumber(Math.round(parseFloat(inputVal) || 0), 0, 100, 0);
        switchState = brightnessPercent > 0;
    }

    // A) RGB lamp
    if (type.isRGB && rgb) {
        const hueBri = maxRgb === 0 ? 0 : clampNumber(Math.round((maxRgb / 255) * 100 * rgbFactor), 1, 100, 1);
        const payload =
            hueBri === 0
                ? { on: false, transitiontime: offFade }
                : { on: true, xy: colorMath.rgbToXy(...rgb), level: hueBri, transitiontime: onFade };
        return {
            groupable: true,
            isOff: hueBri === 0,
            writes: [{ suffix: '.command', value: JSON.stringify(payload) }],
        };
    }

    // B) Dimmer (white ambiance / dimmable / Tradfri)
    if (type.isDimmer) {
        if (brightnessPercent <= 0) {
            return isTradfri
                ? { groupable: false, isOff: true, writes: [{ suffix: '.on', value: false }] }
                : {
                      groupable: true,
                      isOff: true,
                      writes: [{ suffix: '.command', value: JSON.stringify({ on: false, transitiontime: offFade }) }],
                  };
        }

        let miredValue = null;
        if (type.hasCT && rgb) {
            miredValue = colorMath.rgbToMired(...rgb);
        } else if (type.hasCT && config.forceWarmWhiteMired && !wasOn) {
            miredValue = clampNumber(config.forceWarmWhiteMired, 153, 500, 454);
        }

        if (isTradfri) {
            const writes = [{ suffix: '.level', value: brightnessPercent }];
            if (miredValue !== null) {
                writes.push({ suffix: '.ct', value: Math.round(1000000 / miredValue), delayMs: 800 });
            }
            return { groupable: false, isOff: false, writes };
        }

        const command = { on: true, level: brightnessPercent, transitiontime: onFade };
        if (miredValue !== null) {
            command.ct = miredValue;
        }
        return { groupable: true, isOff: false, writes: [{ suffix: '.command', value: JSON.stringify(command) }] };
    }

    // C) Switch / Smart Plug (kept non-groupable so 3rd-party Zigbee plugs like LEDVANCE Plug Z3 receive direct on/off instead of relying on bridge scene recalls)
    if (type.isSwitch) {
        return { groupable: false, isOff: !switchState, writes: [{ suffix: '.on', value: switchState }] };
    }

    return null;
}

/**
 * Converts a computeRawCommand() descriptor into a Hue CLIP v2 scene action object.
 *
 * @param {object} cmd Descriptor returned by computeRawCommand()
 * @param {object} [lightMeta] Optional CLIP v2 light metadata/schemas from GET /clip/v2/resource/light
 * @returns {object|null} CLIP v2 scene `action` object, or null if not bridge-scene-capable
 */
function commandToClipV2Action(cmd, lightMeta) {
    if (!cmd || cmd.groupable === false || !cmd.writes || !cmd.writes.length) {
        return null;
    }

    const parsed = parseJsonCommandWrite(cmd);
    if (parsed) {
        if (!parsed.on) {
            return { on: { on: false } };
        }
        const action = { on: { on: true } };
        if (typeof parsed.level === 'number' && (!lightMeta || lightMeta.hasDimming !== false)) {
            const minDim = lightMeta && typeof lightMeta.minDimLevel === 'number' ? lightMeta.minDimLevel : 0.1;
            const brightness = clampNumber(parsed.level, Math.max(0.1, minDim), 100, 100);
            action.dimming = { brightness: parseFloat(brightness.toFixed(1)) };
        }
        if (Array.isArray(parsed.xy) && parsed.xy.length >= 2 && (!lightMeta || lightMeta.hasColor !== false)) {
            action.color = {
                xy: {
                    x: clampNumber(parsed.xy[0], 0, 1, 0),
                    y: clampNumber(parsed.xy[1], 0, 1, 0),
                },
            };
        } else if (typeof parsed.ct === 'number' && (!lightMeta || lightMeta.hasCT !== false)) {
            const minMired = lightMeta && typeof lightMeta.mirekMin === 'number' ? lightMeta.mirekMin : 153;
            const maxMired = lightMeta && typeof lightMeta.mirekMax === 'number' ? lightMeta.mirekMax : 500;
            action.color_temperature = { mirek: Math.round(clampNumber(parsed.ct, minMired, maxMired, 454)) };
        }
        return action;
    }

    const onWrite = cmd.writes.find(w => w.suffix === '.on');
    return onWrite ? { on: { on: !!onWrite.value } } : null;
}

/**
 * Stable canonical signature of a command (ignoring transitiontime so fade tweaks alone
 * don't defeat deduplication/matching).
 *
 * @param {object|null} cmd Command descriptor
 * @returns {string} Canonical signature string
 */
function commandSignature(cmd) {
    if (!cmd || !cmd.writes || !cmd.writes.length) {
        return '';
    }
    const normalized = cmd.writes.map(w => {
        if (w.suffix !== '.command') {
            return { suffix: w.suffix, value: w.value };
        }
        const parsed = parseJsonCommandWrite({ writes: [w] });
        if (!parsed) {
            return w;
        }
        if (!parsed.on) {
            return { suffix: w.suffix, on: false };
        }
        const out = { suffix: w.suffix, on: true };
        for (const key of ['level', 'xy', 'ct']) {
            if (parsed[key] !== undefined) {
                out[key] = parsed[key];
            }
        }
        return out;
    });
    return JSON.stringify(normalized);
}

/**
 * Stable fingerprint of an entire room scene snapshot map ({ [hueId]: cmd }).
 *
 * @param {Record<string, object>} lightsMap Map of hueId -> command descriptor
 * @returns {string} Canonical fingerprint string
 */
function snapshotFingerprint(lightsMap) {
    if (!lightsMap) {
        return '';
    }
    return JSON.stringify(
        Object.keys(lightsMap)
            .sort()
            .map(hueId => [hueId, commandSignature(lightsMap[hueId])]),
    );
}

module.exports = {
    clampNumber,
    parseLoxoneRgb,
    computeRawCommand,
    commandToClipV2Action,
    commandSignature,
    snapshotFingerprint,
};

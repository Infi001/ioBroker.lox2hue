'use strict';

const colorMath = require('./colorMath');

// No scaling if rgbBrightnessFactor is missing/falsy from config - safer neutral
// fallback than silently sending NaN as brightness to the Hue bridge.
const DEFAULT_RGB_BRIGHTNESS_FACTOR = 1;

// ---------------------------------------------------------------
// Loxone sends RGB outputs as "r,g,b" (optionally "r,g,b,w"), each channel 0-100
// (percent). Convert the first three channels to the 0-255 range used everywhere
// else. Shared by both RGB branches in computeRawCommand() below - previously this
// exact parsing was duplicated inline in two places.
// ---------------------------------------------------------------
/**
 * @param {string} rgbString Loxone-style "r,g,b[,w]" string, each channel 0-100
 * @returns {[number, number, number]} [r, g, b] in the 0-255 range
 */
function parseLoxoneRgb(rgbString) {
    return rgbString
        .split(',')
        .slice(0, 3)
        .map(v => Math.round((255 / 100) * parseInt(v.trim() || '0', 10)));
}

// ---------------------------------------------------------------
// Pure decision logic: given a Loxone input value and everything known about the
// target Hue device, decide what to actually send. No I/O, no adapter state - this
// is what lets it be unit-tested directly (see test/unit.js) without spinning up a
// full adapter/testing harness. main.js's computeCommand() is the thin, stateful
// wrapper around this that looks up `type`/`wasOn` from adapter state and applies
// the result.
// ---------------------------------------------------------------
/**
 * @param {object} params All inputs needed to decide the command, bundled as one object
 * @param {string|number|boolean} params.inputVal Raw value read from the subscribed Loxone state
 * @param {object} params.type Device capabilities as produced by detectDevice() in main.js
 * @param {boolean} params.isTradfri Whether this Hue device is a Tradfri lamp
 * @param {boolean} params.wasOn Whether this lamp was on before this command (see wasOn() in main.js)
 * @param {object} params.config `{ offFadeMs, onFadeMs, rgbBrightnessFactor, forceWarmWhiteMired }`
 * @returns {object|null} A raw command descriptor, or null if this device type can't be controlled
 */
function computeRawCommand({ inputVal, type, isTradfri, wasOn, config }) {
    // The Hue Bridge API expects "transitiontime" in deciseconds - the admin UI shows
    // milliseconds instead (easier to understand), so convert here.
    const offFade = Math.round((config.offFadeMs || 700) / 100);
    const onFade = Math.round((config.onFadeMs || 700) / 100);
    const rgbFactor = config.rgbBrightnessFactor || DEFAULT_RGB_BRIGHTNESS_FACTOR;

    let brightnessPercent = 0;
    let rgbString = null;
    let switchState = false;

    if (typeof inputVal === 'string' && inputVal.includes(',')) {
        rgbString = inputVal;
        const parts = rgbString.split(',');
        const r = parseFloat(parts[0]) || 0;
        const g = parseFloat(parts[1]) || 0;
        const b = parseFloat(parts[2]) || 0;
        const maxVal = Math.max(r, g, b);
        brightnessPercent = maxVal > 100 ? Math.round((maxVal / 255) * 100) : Math.round(maxVal);
    } else if (typeof inputVal === 'boolean') {
        brightnessPercent = inputVal ? 100 : 0;
        switchState = brightnessPercent > 0;
    } else {
        brightnessPercent = Math.round(parseFloat(inputVal) || 0);
        switchState = brightnessPercent > 0;
    }

    // A) RGB
    if (type.isRGB && rgbString) {
        const [r, g, b] = parseLoxoneRgb(rgbString);
        const hueBri = Math.round((Math.max(r, g, b) / 2.55) * rgbFactor);

        if (hueBri === 0) {
            return {
                groupable: true,
                isOff: true,
                writes: [{ suffix: '.command', value: JSON.stringify({ on: false, transitiontime: offFade }) }],
            };
        }
        const xy = colorMath.rgbToXy(r, g, b);
        return {
            groupable: true,
            isOff: false,
            writes: [
                {
                    suffix: '.command',
                    value: JSON.stringify({ on: true, xy, level: hueBri, transitiontime: onFade }),
                },
            ],
        };
    }

    // B) Dimmer / white ambiance
    if (type.isDimmer) {
        if (brightnessPercent <= 0) {
            if (isTradfri) {
                return { groupable: false, isOff: true, writes: [{ suffix: '.on', value: false }] };
            }
            return {
                groupable: true,
                isOff: true,
                writes: [{ suffix: '.command', value: JSON.stringify({ on: false, transitiontime: offFade }) }],
            };
        }

        // Determine color temperature (mired) - two very different cases:
        let miredValue = null;
        if (type.hasCT && rgbString) {
            // The Loxone output is RGB, but this Hue lamp only supports brightness +
            // color temperature (no real RGB) - instead of ignoring the color info,
            // approximate it as a color temperature (see colorMath.rgbToMired()).
            // Recomputed on EVERY change (not just on switch-on), because Loxone is
            // actively sending a color intent here - unlike the fixed value below,
            // where Loxone has no color info at all.
            const [r, g, b] = parseLoxoneRgb(rgbString);
            miredValue = colorMath.rgbToMired(r, g, b);
        } else if (type.hasCT && config.forceWarmWhiteMired && !wasOn) {
            // The Loxone output is a plain dimmer (no RGB, no color info whatsoever) -
            // only apply the configured fixed value on the off->on transition (see
            // wasOn() in main.js), so later manual Hue-app adjustments survive
            // subsequent dimming instead of being fought over.
            miredValue = config.forceWarmWhiteMired;
        }

        const command = { on: true, level: brightnessPercent, transitiontime: onFade };
        if (miredValue !== null) {
            command.ct = miredValue;
        }

        if (isTradfri) {
            const writes = [{ suffix: '.level', value: brightnessPercent }];
            // The separate ".ct" state (used instead of .command, because .command is
            // unreliable for Tradfri) expects Kelvin for this device type, not mired
            // like the standard Hue API ".command" path.
            if (miredValue !== null) {
                const kelvin = Math.round(1000000 / miredValue);
                writes.push({ suffix: '.ct', value: kelvin, delayMs: 800 });
            }
            return { groupable: false, isOff: false, writes };
        }
        return {
            groupable: true,
            isOff: false,
            writes: [{ suffix: '.command', value: JSON.stringify(command) }],
        };
    }

    // C) Switch
    if (type.isSwitch) {
        return {
            groupable: true,
            isOff: !switchState,
            writes: [{ suffix: '.on', value: switchState }],
        };
    }

    return null;
}

module.exports = { computeRawCommand, parseLoxoneRgb };

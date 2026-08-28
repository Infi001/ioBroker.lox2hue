'use strict';

// ---------------------------------------------------------------
// Convert RGB (0-255 per channel) to a CIE xy chromaticity point (the standard Hue
// color-space formula: sRGB -> gamma correction -> XYZ -> xy). Used both for real RGB
// lamps and (for the mired approximation, see rgbToMired()) for white-ambiance lamps.
// Pure function, no adapter state needed - extracted here so it can be unit-tested on
// its own (see test/unit.js).
// ---------------------------------------------------------------
/**
 * Converts an RGB color to a CIE xy chromaticity point (Hue color-space formula).
 *
 * @param {number} r Red channel (0-255)
 * @param {number} g Green channel (0-255)
 * @param {number} b Blue channel (0-255)
 * @returns {[number, number]} [x, y] chromaticity point in the CIE 1931 diagram
 */
function rgbToXy(r, g, b) {
    const gammaCorrect = v => (v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92);
    const [lr, lg, lb] = [r, g, b].map(v => gammaCorrect(v / 255));
    const X = lr * 0.664511 + lg * 0.154324 + lb * 0.162028;
    const Y = lr * 0.283881 + lg * 0.668433 + lb * 0.047685;
    const Z = lr * 0.000088 + lg * 0.07231 + lb * 0.986039;
    const divisor = X + Y + Z;
    return divisor === 0 ? [0, 0] : [parseFloat((X / divisor).toFixed(4)), parseFloat((Y / divisor).toFixed(4))];
}

// ---------------------------------------------------------------
// Estimate an approximate color temperature (in mired) from an RGB color - for
// white-ambiance lamps (no real RGB, only brightness + color temperature) when the
// Loxone output sends RGB anyway: instead of ignoring the color info entirely and
// always applying one fixed color temperature, this tries to reproduce the "warmth"
// of the sent color as a color temperature.
//
// IMPORTANT: RGB <-> color temperature is not an exact 1:1 conversion (a saturated
// color like pure red or green has no physically meaningful color temperature at all -
// that only exists for points near the "Planckian locus", i.e. white/yellow/blue
// tones). Uses McCamy's approximation formula (CIE xy -> CCT); the result is clamped
// to a sensible range so that even strongly saturated input colors never produce a
// technically valid but nonsensical extreme value.
// ---------------------------------------------------------------
/**
 * Estimates an approximate color temperature (in mired) from an RGB color, clamped to
 * the valid Hue range of 153-500 mired.
 *
 * @param {number} r Red channel (0-255)
 * @param {number} g Green channel (0-255)
 * @param {number} b Blue channel (0-255)
 * @returns {number} Color temperature in mired, clamped to [153, 500]
 */
function rgbToMired(r, g, b) {
    const [x, y] = rgbToXy(r, g, b);
    const n = (x - 0.332) / (0.1858 - y);
    const cct = 437 * n ** 3 + 3601 * n ** 2 + 6861 * n + 5517;
    const mired = Math.round(1000000 / cct);
    return Math.min(500, Math.max(153, mired));
}

module.exports = { rgbToXy, rgbToMired };

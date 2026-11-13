'use strict';

/**
 * Clamps a single color channel to [0, 255].
 *
 * @param {number} v Input channel value
 * @returns {number} Clamped channel value (0-255)
 */
function clampChannel(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;
}

/**
 * Converts an RGB color to a CIE xy chromaticity point (Hue color-space formula).
 *
 * @param {number} r Red channel (0-255)
 * @param {number} g Green channel (0-255)
 * @param {number} b Blue channel (0-255)
 * @returns {[number, number]} [x, y] chromaticity point in the CIE 1931 diagram
 */
function rgbToXy(r, g, b) {
    const [lr, lg, lb] = [r, g, b].map(v => {
        const s = clampChannel(v) / 255;
        return s > 0.04045 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92;
    });
    const X = lr * 0.664511 + lg * 0.154324 + lb * 0.162028;
    const Y = lr * 0.283881 + lg * 0.668433 + lb * 0.047685;
    const Z = lr * 0.000088 + lg * 0.07231 + lb * 0.986039;
    const sum = X + Y + Z;
    if (sum === 0) {
        return [0, 0];
    }
    const clamp01 = n => Math.min(1, Math.max(0, parseFloat(n.toFixed(4))));
    return [clamp01(X / sum), clamp01(Y / sum)];
}

/**
 * Estimates an approximate color temperature (in mired) from an RGB color using McCamy's
 * approximation, clamped to the valid Hue range of 153-500 mired.
 *
 * @param {number} r Red channel (0-255)
 * @param {number} g Green channel (0-255)
 * @param {number} b Blue channel (0-255)
 * @returns {number} Color temperature in mired, clamped to [153, 500]
 */
function rgbToMired(r, g, b) {
    const [x, y] = rgbToXy(r, g, b);
    if ((x === 0 && y === 0) || Math.abs(0.1858 - y) < 1e-6) {
        return 454;
    }
    const n = (x - 0.332) / (0.1858 - y);
    const cct = 437 * n ** 3 + 3601 * n ** 2 + 6861 * n + 5517;
    const mired = cct > 0 && Number.isFinite(cct) ? Math.round(1000000 / cct) : 454;
    return Number.isFinite(mired) ? Math.min(500, Math.max(153, mired)) : 454;
}

module.exports = { rgbToXy, rgbToMired };

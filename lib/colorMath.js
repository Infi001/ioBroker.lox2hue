"use strict";

// ---------------------------------------------------------------
// RGB (0-255 je Kanal) in CIE-xy-Farbort umrechnen (Standard-Hue-Farbraum-Formel,
// sRGB -> Gamma-Korrektur -> XYZ -> xy). Wird sowohl fuer echte RGB-Lampen als auch
// (fuer die Mired-Naeherung, siehe rgbZuMired()) fuer White-Ambiance-Lampen gebraucht.
// Reine Funktion, kein Adapter-Zustand noetig - deshalb hier ausgelagert und einzeln
// testbar (siehe test/unit.js).
// ---------------------------------------------------------------
/**
 * Rechnet eine RGB-Farbe in den CIE-xy-Farbort um (Hue-Farbraum-Formel).
 *
 * @param {number} r Rot-Anteil (0-255)
 * @param {number} g Gruen-Anteil (0-255)
 * @param {number} b Blau-Anteil (0-255)
 * @returns {[number, number]} [x, y] Farbort im CIE-1931-Diagramm
 */
function rgbZuXy(r, g, b) {
  const gammaCorrect = (v) =>
    v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const [lr, lg, lb] = [r, g, b].map((v) => gammaCorrect(v / 255));
  const X = lr * 0.664511 + lg * 0.154324 + lb * 0.162028;
  const Y = lr * 0.283881 + lg * 0.668433 + lb * 0.047685;
  const Z = lr * 0.000088 + lg * 0.07231 + lb * 0.986039;
  const divisor = X + Y + Z;
  return divisor === 0
    ? [0, 0]
    : [
        parseFloat((X / divisor).toFixed(4)),
        parseFloat((Y / divisor).toFixed(4)),
      ];
}

// ---------------------------------------------------------------
// Naeherungsweise Farbtemperatur (in mired) aus einer RGB-Farbe schaetzen - fuer
// White-Ambiance-Lampen (kein echtes RGB, nur Helligkeit + Farbtemperatur), wenn der
// Loxone-Ausgang trotzdem RGB liefert: statt die Farbinfo komplett zu ignorieren und
// immer nur eine feste Farbtemperatur zu setzen, wird versucht, den "Warmton" der
// gesendeten Farbe als Farbtemperatur nachzubilden.
//
// WICHTIG: RGB <-> Farbtemperatur ist keine exakte 1:1-Umrechnung (eine gesaettigte
// Farbe wie reines Rot oder Gruen hat physikalisch gar keine sinnvolle Farbtemperatur -
// das gibt's nur fuer Punkte nahe der "Planckschen Kurve", also Weiss-/Gelb-/Blau-Toene).
// Genutzt wird McCamys Naeherungsformel (CIE xy -> CCT), das Ergebnis wird auf einen
// sinnvollen Bereich begrenzt, damit auch bei stark gesaettigten Eingabefarben kein
// technisch gueltiger, aber unsinniger Extremwert rauskommt.
// ---------------------------------------------------------------
/**
 * Schaetzt eine Naeherungs-Farbtemperatur (in mired) aus einer RGB-Farbe, geklemmt
 * auf den gueltigen Hue-Bereich 153-500 mired.
 *
 * @param {number} r Rot-Anteil (0-255)
 * @param {number} g Gruen-Anteil (0-255)
 * @param {number} b Blau-Anteil (0-255)
 * @returns {number} Farbtemperatur in mired, geklemmt auf [153, 500]
 */
function rgbZuMired(r, g, b) {
  const [x, y] = rgbZuXy(r, g, b);
  const n = (x - 0.332) / (0.1858 - y);
  const cct = 437 * n ** 3 + 3601 * n ** 2 + 6861 * n + 5517;
  const mired = Math.round(1000000 / cct);
  return Math.min(500, Math.max(153, mired));
}

module.exports = { rgbZuXy, rgbZuMired };

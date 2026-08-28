const { expect } = require('chai');
const { rgbZuXy, rgbZuMired } = require('../lib/colorMath');

describe('colorMath', () => {
    describe('rgbZuXy()', () => {
        it('gibt [0, 0] fuer Schwarz zurueck', () => {
            expect(rgbZuXy(0, 0, 0)).to.deep.equal([0, 0]);
        });

        it('liefert plausible xy-Werte fuer reines Rot (innerhalb des sichtbaren Bereichs)', () => {
            const [x, y] = rgbZuXy(255, 0, 0);
            expect(x).to.be.within(0, 1);
            expect(y).to.be.within(0, 1);
            // Reines Rot liegt im CIE-Diagramm deutlich rechts (hoher x-Wert)
            expect(x).to.be.greaterThan(0.6);
        });

        it('liefert plausible xy-Werte fuer reines Blau (niedriger x-Wert, niedriger y-Wert)', () => {
            const [x, y] = rgbZuXy(0, 0, 255);
            expect(x).to.be.lessThan(0.2);
            expect(y).to.be.lessThan(0.2);
        });
    });

    describe('rgbZuMired()', () => {
        it('begrenzt das Ergebnis immer auf den gueltigen Mired-Bereich 153-500', () => {
            const proben = [
                [255, 0, 0],     // reines Rot - keine sinnvolle Farbtemperatur, muss geklemmt werden
                [0, 255, 0],     // reines Gruen - ebenfalls ausserhalb der Planckschen Kurve
                [0, 0, 255],     // reines Blau
                [255, 255, 255], // neutrales Weiss
                [255, 180, 100], // warmes Kerzenlicht
                [200, 220, 255]  // kuehles Blauweiss
            ];
            for (const [r, g, b] of proben) {
                const mired = rgbZuMired(r, g, b);
                expect(mired).to.be.at.least(153);
                expect(mired).to.be.at.most(500);
            }
        });

        it('ordnet waermeres Orange einen hoeheren Mired-Wert zu als kuehleres Blauweiss', () => {
            const warm = rgbZuMired(255, 140, 50);
            const kuehl = rgbZuMired(200, 220, 255);
            expect(warm).to.be.greaterThan(kuehl);
        });

        it('liefert einen ganzzahligen Mired-Wert', () => {
            const mired = rgbZuMired(255, 180, 100);
            expect(Number.isInteger(mired)).to.be.true;
        });
    });
});

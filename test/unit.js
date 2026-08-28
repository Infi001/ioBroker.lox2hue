const { expect } = require('chai');
const { rgbToXy, rgbToMired } = require('../lib/colorMath');
const { computeRawCommand, parseLoxoneRgb } = require('../lib/commandLogic');

describe('colorMath', () => {
    describe('rgbToXy()', () => {
        it('returns [0, 0] for black', () => {
            expect(rgbToXy(0, 0, 0)).to.deep.equal([0, 0]);
        });

        it('returns a plausible xy value for pure red (within the visible range)', () => {
            const [x, y] = rgbToXy(255, 0, 0);
            expect(x).to.be.within(0, 1);
            expect(y).to.be.within(0, 1);
            // Pure red sits well to the right in the CIE diagram (high x value)
            expect(x).to.be.greaterThan(0.6);
        });

        it('returns a plausible xy value for pure blue (low x, low y)', () => {
            const [x, y] = rgbToXy(0, 0, 255);
            expect(x).to.be.lessThan(0.2);
            expect(y).to.be.lessThan(0.2);
        });
    });

    describe('rgbToMired()', () => {
        it('always clamps the result to the valid mired range 153-500', () => {
            const samples = [
                [255, 0, 0], // pure red - no meaningful color temperature, must be clamped
                [0, 255, 0], // pure green - also off the Planckian locus
                [0, 0, 255], // pure blue
                [255, 255, 255], // neutral white
                [255, 180, 100], // warm candle light
                [200, 220, 255], // cool blue-white
            ];
            for (const [r, g, b] of samples) {
                const mired = rgbToMired(r, g, b);
                expect(mired).to.be.at.least(153);
                expect(mired).to.be.at.most(500);
            }
        });

        it('assigns a higher mired value to warmer orange than to cooler blue-white', () => {
            const warm = rgbToMired(255, 140, 50);
            const cool = rgbToMired(200, 220, 255);
            expect(warm).to.be.greaterThan(cool);
        });

        it('returns an integer mired value', () => {
            const mired = rgbToMired(255, 180, 100);
            expect(Number.isInteger(mired)).to.be.true;
        });
    });
});

describe('commandLogic', () => {
    const baseConfig = {
        offFadeMs: 700,
        onFadeMs: 700,
        rgbBrightnessFactor: 0.4,
        forceWarmWhiteMired: 454,
    };
    const rgbType = { isRGB: true, isDimmer: false, isSwitch: false, hasCT: false };
    const ctDimmerType = { isRGB: false, isDimmer: true, isSwitch: false, hasCT: true };
    const plainDimmerType = { isRGB: false, isDimmer: true, isSwitch: false, hasCT: false };
    const switchType = { isRGB: false, isDimmer: false, isSwitch: true, hasCT: false };
    const unknownType = { isRGB: false, isDimmer: false, isSwitch: false, hasCT: false };

    describe('parseLoxoneRgb()', () => {
        it('converts a Loxone percent string to a 0-255 RGB array', () => {
            // 50% -> 2.55*50 is 127.49999999999999 in floating point, so this rounds
            // down to 127, not 128 - matches Math.round(), not exact decimal math.
            expect(parseLoxoneRgb('100,50,0')).to.deep.equal([255, 127, 0]);
        });

        it('ignores a trailing white channel', () => {
            expect(parseLoxoneRgb('100,0,0,50')).to.deep.equal([255, 0, 0]);
        });
    });

    describe('computeRawCommand() - RGB lamps', () => {
        it('produces an "on" command with xy color and scaled brightness', () => {
            const cmd = computeRawCommand({
                inputVal: '100,100,100',
                type: rgbType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(cmd.isOff).to.be.false;
            expect(cmd.writes).to.have.lengthOf(1);
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.on).to.be.true;
            expect(parsed.xy).to.be.an('array');
            // rgbBrightnessFactor 0.4 caps 100% Loxone brightness at 40
            expect(parsed.level).to.equal(40);
        });

        it('produces an "off" command when brightness is 0', () => {
            const cmd = computeRawCommand({
                inputVal: '0,0,0',
                type: rgbType,
                isTradfri: false,
                wasOn: true,
                config: baseConfig,
            });
            expect(cmd.isOff).to.be.true;
            expect(JSON.parse(cmd.writes[0].value).on).to.be.false;
        });
    });

    describe('computeRawCommand() - white-ambiance dimmer, plain Loxone dimmer output', () => {
        it('applies the fixed mired value on the off->on transition', () => {
            const cmd = computeRawCommand({
                inputVal: 80,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.ct).to.equal(454);
            expect(parsed.level).to.equal(80);
        });

        it('does NOT re-apply the fixed mired value while already on (leaves manual Hue-app tuning alone)', () => {
            const cmd = computeRawCommand({
                inputVal: 60,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: true,
                config: baseConfig,
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.ct).to.be.undefined;
        });

        it('never sets ct when forceWarmWhiteMired is 0', () => {
            const cmd = computeRawCommand({
                inputVal: 80,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: { ...baseConfig, forceWarmWhiteMired: 0 },
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.ct).to.be.undefined;
        });
    });

    describe('computeRawCommand() - white-ambiance dimmer, color-picker Loxone output', () => {
        it('derives an approximate mired value from RGB on every change, regardless of wasOn', () => {
            const cmd = computeRawCommand({
                inputVal: '100,60,20',
                type: ctDimmerType,
                isTradfri: false,
                wasOn: true,
                config: baseConfig,
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.ct).to.be.a('number');
            expect(parsed.ct).to.be.at.least(153).and.at.most(500);
        });
    });

    describe('computeRawCommand() - Tradfri special case', () => {
        it('uses a plain ".on" write (not ".command") when switching off', () => {
            const cmd = computeRawCommand({
                inputVal: 0,
                type: ctDimmerType,
                isTradfri: true,
                wasOn: true,
                config: baseConfig,
            });
            expect(cmd.groupable).to.be.false;
            expect(cmd.writes).to.deep.equal([{ suffix: '.on', value: false }]);
        });

        it('sends level and a delayed .ct write in Kelvin (not mired) on off->on', () => {
            const cmd = computeRawCommand({
                inputVal: 70,
                type: ctDimmerType,
                isTradfri: true,
                wasOn: false,
                config: baseConfig,
            });
            const levelWrite = cmd.writes.find(w => w.suffix === '.level');
            const ctWrite = cmd.writes.find(w => w.suffix === '.ct');
            expect(levelWrite.value).to.equal(70);
            expect(ctWrite.delayMs).to.equal(800);
            // 454 mired -> round(1_000_000 / 454) Kelvin
            expect(ctWrite.value).to.equal(Math.round(1000000 / 454));
        });
    });

    describe('computeRawCommand() - switches', () => {
        it('maps a truthy value to an ".on" write', () => {
            const cmd = computeRawCommand({
                inputVal: true,
                type: switchType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(cmd.isOff).to.be.false;
            expect(cmd.writes).to.deep.equal([{ suffix: '.on', value: true }]);
        });
    });

    describe('computeRawCommand() - undetected device', () => {
        it('returns null when the device has no usable capability at all', () => {
            const cmd = computeRawCommand({
                inputVal: 100,
                type: unknownType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(cmd).to.be.null;
        });
    });

    describe('computeRawCommand() - defensive fallback', () => {
        it('does not produce NaN brightness for RGB lamps when rgbBrightnessFactor is missing', () => {
            const cmd = computeRawCommand({
                inputVal: '100,100,100',
                type: rgbType,
                isTradfri: false,
                wasOn: false,
                config: { ...baseConfig, rgbBrightnessFactor: undefined },
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(Number.isNaN(parsed.level)).to.be.false;
        });
    });
});

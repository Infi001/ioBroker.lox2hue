const { expect } = require('chai');
const { rgbToXy, rgbToMired } = require('../lib/colorMath');
const {
    parseLoxoneRgb,
    computeRawCommand,
    commandToClipV2Action,
    commandSignature,
    snapshotFingerprint,
} = require('../lib/commandLogic');
const {
    isValidStaticMood,
    normalizeMoodKey,
    buildBridgeSceneName,
    buildCacheZoneName,
    handleMoodChange,
    handleLampChange,
    markSettled,
    shouldSuppressEcho,
} = require('../lib/sceneStateMachine');

describe('colorMath', () => {
    describe('rgbToXy()', () => {
        it('returns [0, 0] for black', () => {
            expect(rgbToXy(0, 0, 0)).to.deep.equal([0, 0]);
        });

        it('returns a plausible xy value for pure red (within the visible range)', () => {
            const [x, y] = rgbToXy(255, 0, 0);
            expect(x).to.be.within(0, 1);
            expect(y).to.be.within(0, 1);
            expect(x).to.be.greaterThan(0.6);
        });

        it('clamps out-of-range inputs cleanly to [0, 1] CIE coordinates', () => {
            const [x, y] = rgbToXy(650, -10, 50);
            expect(x).to.be.within(0, 1);
            expect(y).to.be.within(0, 1);
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
                [0, 0, 0],
                [255, 0, 0],
                [0, 255, 0],
                [0, 0, 255],
                [255, 255, 255],
                [255, 180, 100],
                [200, 220, 255],
            ];
            for (const [r, g, b] of samples) {
                const mired = rgbToMired(r, g, b);
                expect(mired).to.be.at.least(153);
                expect(mired).to.be.at.most(500);
                expect(Number.isInteger(mired)).to.be.true;
            }
        });

        it('assigns a higher mired value to warmer orange than to cooler blue-white', () => {
            const warm = rgbToMired(255, 140, 50);
            const cool = rgbToMired(200, 220, 255);
            expect(warm).to.be.greaterThan(cool);
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
    const fullBrightnessConfig = { ...baseConfig, rgbBrightnessFactor: 1 };
    const rgbType = { isRGB: true, isDimmer: false, isSwitch: false, hasCT: false };
    const ctDimmerType = { isRGB: false, isDimmer: true, isSwitch: false, hasCT: true };
    const switchType = { isRGB: false, isDimmer: false, isSwitch: true, hasCT: false };
    const unknownType = { isRGB: false, isDimmer: false, isSwitch: false, hasCT: false };

    describe('parseLoxoneRgb()', () => {
        it('parses iobroker.loxone 0-255 RGB strings directly without double scaling', () => {
            expect(parseLoxoneRgb('204,84,10')).to.deep.equal([204, 84, 10]);
            expect(parseLoxoneRgb('255,110,13')).to.deep.equal([255, 110, 13]);
        });

        it('clamps out-of-range values and ignores trailing white channel', () => {
            expect(parseLoxoneRgb('300,-5,127.6,50')).to.deep.equal([255, 0, 128]);
        });
    });

    describe('computeRawCommand() - RGB lamps', () => {
        it('produces an "on" command with accurate xy color and scaled brightness (0-255 input)', () => {
            const cmd = computeRawCommand({
                inputVal: '255,255,255',
                type: rgbType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(cmd.isOff).to.be.false;
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.on).to.be.true;
            expect(parsed.xy).to.be.an('array');
            // 255/255 = 100%, scaled by 0.4 -> 40
            expect(parsed.level).to.equal(40);
        });

        it('never exceeds level 100 at full brightness factor', () => {
            const cmd = computeRawCommand({
                inputVal: '255,110,13',
                type: rgbType,
                isTradfri: false,
                wasOn: false,
                config: fullBrightnessConfig,
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.level).to.equal(100);
        });

        it('respects explicit 0ms fade duration instead of falling back to 700ms', () => {
            const cmd = computeRawCommand({
                inputVal: '0,0,0',
                type: rgbType,
                isTradfri: false,
                wasOn: true,
                config: { ...fullBrightnessConfig, offFadeMs: 0 },
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.transitiontime).to.equal(0);
        });
    });

    describe('computeRawCommand() - white-ambiance dimmer', () => {
        it('applies fixed mired on off->on transition only', () => {
            const cmdOffOn = computeRawCommand({
                inputVal: 80,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(JSON.parse(cmdOffOn.writes[0].value).ct).to.equal(454);

            const cmdWhileOn = computeRawCommand({
                inputVal: 60,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: true,
                config: baseConfig,
            });
            expect(JSON.parse(cmdWhileOn.writes[0].value).ct).to.be.undefined;
        });

        it('derives mired from RGB when Loxone output is ColorPicker', () => {
            const cmd = computeRawCommand({
                inputVal: '204,84,10',
                type: ctDimmerType,
                isTradfri: false,
                wasOn: true,
                config: baseConfig,
            });
            const parsed = JSON.parse(cmd.writes[0].value);
            expect(parsed.level).to.equal(80);
            expect(parsed.ct).to.be.within(153, 500);
        });
    });

    describe('computeRawCommand() - Tradfri & Switch & Unknown', () => {
        it('keeps Tradfri on separate non-groupable writes', () => {
            const cmd = computeRawCommand({
                inputVal: 70,
                type: ctDimmerType,
                isTradfri: true,
                wasOn: false,
                config: baseConfig,
            });
            expect(cmd.groupable).to.be.false;
            expect(cmd.writes.find(w => w.suffix === '.level').value).to.equal(70);
            expect(cmd.writes.find(w => w.suffix === '.ct').value).to.equal(Math.round(1000000 / 454));
        });

        it('maps switches and returns null for unknown devices', () => {
            expect(
                computeRawCommand({ inputVal: true, type: switchType, isTradfri: false, wasOn: false, config: baseConfig })
                    .writes,
            ).to.deep.equal([{ suffix: '.on', value: true }]);
            expect(
                computeRawCommand({ inputVal: 100, type: unknownType, isTradfri: false, wasOn: false, config: baseConfig }),
            ).to.be.null;
        });
    });

    describe('commandToClipV2Action()', () => {
        it('builds spec-compliant CLIP v2 RGB action clamped to brightness <= 100', () => {
            const cmd = computeRawCommand({
                inputVal: '204,84,10',
                type: rgbType,
                isTradfri: false,
                wasOn: false,
                config: fullBrightnessConfig,
            });
            const action = commandToClipV2Action(cmd, { hasDimming: true, hasColor: true, hasCT: false, minDimLevel: 1 });
            expect(action.on).to.deep.equal({ on: true });
            expect(action.dimming).to.deep.equal({ brightness: 80 });
            expect(action.color.xy).to.have.all.keys('x', 'y');
        });

        it('builds pure on/off action for smart plugs without dimming', () => {
            const cmd = computeRawCommand({
                inputVal: true,
                type: switchType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            expect(commandToClipV2Action(cmd, { hasDimming: false })).to.deep.equal({ on: { on: true } });
        });

        it('clamps white-ambiance mirek against bridge mirek_schema', () => {
            const cmd = computeRawCommand({
                inputVal: 50,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: baseConfig,
            });
            const action = commandToClipV2Action(cmd, {
                hasDimming: true,
                hasColor: false,
                hasCT: true,
                mirekMin: 200,
                mirekMax: 440,
            });
            expect(action).to.deep.equal({
                on: { on: true },
                dimming: { brightness: 50 },
                color_temperature: { mirek: 440 },
            });
        });

        it('returns null for non-groupable Tradfri commands', () => {
            const cmd = computeRawCommand({
                inputVal: 50,
                type: ctDimmerType,
                isTradfri: true,
                wasOn: false,
                config: baseConfig,
            });
            expect(commandToClipV2Action(cmd)).to.be.null;
        });
    });

    describe('commandSignature() & snapshotFingerprint()', () => {
        it('ignores transitiontime differences when comparing commands', () => {
            const a = computeRawCommand({
                inputVal: 50,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: { ...baseConfig, onFadeMs: 700 },
            });
            const b = computeRawCommand({
                inputVal: 50,
                type: ctDimmerType,
                isTradfri: false,
                wasOn: false,
                config: { ...baseConfig, onFadeMs: 1200 },
            });
            expect(commandSignature(a)).to.equal(commandSignature(b));
            expect(snapshotFingerprint({ 'hue.0.L1': a })).to.equal(snapshotFingerprint({ 'hue.0.L1': b }));
        });
    });
});

describe('sceneStateMachine', () => {
    it('validates static moods cleanly (rejects negative/NaN/empty)', () => {
        expect(isValidStaticMood('778')).to.be.true;
        expect(isValidStaticMood(0)).to.be.true;
        expect(isValidStaticMood('-1')).to.be.false;
        expect(isValidStaticMood(-1)).to.be.false;
        expect(isValidStaticMood(undefined)).to.be.false;
        expect(isValidStaticMood('')).to.be.false;
        expect(normalizeMoodKey('002')).to.equal('2');
    });

    it('builds unique <= 32-char scene names using leading UUID block chars', () => {
        const a = buildBridgeSceneName('loxone.0.13339a60-001e-6594-ffff7dd9eafbeece', '778');
        const b = buildBridgeSceneName('loxone.0.13339a60-02ec-6c05-ffff7dd9eafbeece', '778');
        expect(a).to.not.equal(b);
        expect(a.length).to.be.at.most(32);
        expect(b.length).to.be.at.most(32);
        const zA = buildCacheZoneName('loxone.0.13339a60-001e-6594-ffff7dd9eafbeece');
        const zB = buildCacheZoneName('loxone.0.13339a60-02ec-6c05-ffff7dd9eafbeece');
        expect(zA).to.not.equal(zB);
        expect(zA).to.match(/^lox2hue: /);
        expect(zA.length).to.be.at.most(32);
    });

    it('does NOT misclassify a long-active static mood as dynamic when Loxone emits lamp changes before activeMoodsNum', () => {
        const room = {
            currentMoodNum: '1',
            currentMoodSince: 1000,
            burstStartAt: null,
            burstEvents: 0,
            lastWaveAt: 0,
        };
        // Two hours later (7,200,000ms), Loxone switches Mood 1 -> Mood 778 and sends lamp updates 5ms BEFORE activeMoodsNum
        const lamp1Res = handleLampChange(room, 7200000);
        const lamp2Res = handleLampChange(room, 7200001);
        expect(lamp1Res.isDynamic).to.be.false;
        expect(lamp2Res.isDynamic).to.be.false;

        const moodRes = handleMoodChange(room, '778', 7200005);
        expect(moodRes.isStatic).to.be.true;
        expect(moodRes.moodKey).to.equal('778');
        expect(room.currentMoodNum).to.equal('778');
        expect(room.burstStartAt).to.equal(7200005);
    });

    it('marks a mood as dynamic only after sustained continuous change waves (>30s without pause)', () => {
        const room = {};
        handleMoodChange(room, '6', 1000);
        // Simulate waves every 5s over 35s
        for (const t of [6000, 11000, 16000, 21000, 26000, 32000]) {
            const res = handleLampChange(room, t, { dynamicGiveUpMs: 30000 });
            if (t < 32000) {
                expect(res.isDynamic).to.be.false;
            } else {
                expect(res.isDynamic).to.be.true;
                expect(res.moodKey).to.equal('6');
            }
        }
    });

    it('ignores manual mode (-1) and never marks it dynamic', () => {
        const room = {};
        const moodRes = handleMoodChange(room, '-1', 1000);
        expect(moodRes.isStatic).to.be.false;
        for (const t of [6000, 16000, 26000, 36000, 46000]) {
            const res = handleLampChange(room, t, { dynamicGiveUpMs: 30000 });
            expect(res.isDynamic).to.be.false;
            expect(res.scheduleSettle).to.be.false;
        }
    });

    it('suppresses matching lamp echoes right after a scene recall while letting differing values through', () => {
        const cfg = { offFadeMs: 700, onFadeMs: 700, rgbBrightnessFactor: 1, forceWarmWhiteMired: 454 };
        const ctDimmer = { isRGB: false, isDimmer: true, isSwitch: false, hasCT: true };
        const expected = computeRawCommand({ inputVal: 60, type: ctDimmer, isTradfri: false, wasOn: false, config: cfg });
        const modified = computeRawCommand({ inputVal: 25, type: ctDimmer, isTradfri: false, wasOn: false, config: cfg });

        const room = {};
        handleMoodChange(room, '2', 1000);
        markSettled(room);
        room.recalledMoodNum = '2';
        room.recalledUntil = 2500;

        const cachedEntry = { bridgeSceneId: 'abc', lights: { 'hue.0.L1': expected } };

        expect(
            shouldSuppressEcho({
                room,
                hueId: 'hue.0.L1',
                incomingCmd: expected,
                cachedEntry,
                now: 1200,
                commandSignatureFn: commandSignature,
            }),
        ).to.be.true;

        // Differing value (e.g. user/Loxone changed brightness to 25%) MUST NOT be suppressed
        expect(
            shouldSuppressEcho({
                room,
                hueId: 'hue.0.L1',
                incomingCmd: modified,
                cachedEntry,
                now: 1200,
                commandSignatureFn: commandSignature,
            }),
        ).to.be.false;
    });
});

describe('Loxone2Hue adapter end-to-end (mocked ioBroker + CLIP v2 bridge)', () => {
    const EventEmitter = require('node:events');
    const https = require('node:https');
    const Module = require('node:module');

    function createMockHarness() {
        const origLoad = Module._load;
        const origHttpsRequest = https.request;

        const foreignObjects = {
            'system.adapter.hue.0': { native: { bridge: '192.168.2.57', port: 443 } },
            'hue.0.rgb1': { native: { id: '1' } },
            'hue.0.rgb1.xy': { type: 'state' },
            'hue.0.rgb1.ct': { type: 'state' },
            'hue.0.rgb1.level': { type: 'state' },
            'hue.0.rgb1.on': { type: 'state' },
            'hue.0.rgb1.reachable': { type: 'state' },
            'hue.0.ct2': { native: { id: '2' } },
            'hue.0.ct2.ct': { type: 'state' },
            'hue.0.ct2.level': { type: 'state' },
            'hue.0.ct2.on': { type: 'state' },
            'hue.0.ct2.reachable': { type: 'state' },
            'hue.0.plug3': { native: { id: '3' } },
            'hue.0.plug3.on': { type: 'state' },
            'hue.0.plug3.reachable': { type: 'state' },
            'loxone.0.roomA.AI1': { common: { name: 'RGB 1' }, native: { control: { type: 'ColorPickerV2' } } },
            'loxone.0.roomA.AI2': { common: { name: 'CT 2' }, native: { control: { type: 'Dimmer' } } },
            'loxone.0.roomA.AI3': { common: { name: 'Plug 3' }, native: { control: { type: 'Switch' } } },
            'loxone.0.roomA.activeMoodsNum': { type: 'state' },
            'loxone.0.roomA.AI1.rgb': { type: 'state' },
            'loxone.0.roomA.AI2.position': { type: 'state' },
            'loxone.0.roomA.AI3.active': { type: 'state' },
        };

        const foreignStates = {
            'loxone.0.roomA.activeMoodsNum': { val: 778 },
            'loxone.0.roomA.AI1.rgb': { val: '0,0,0' },
            'loxone.0.roomA.AI2.position': { val: 0 },
            'loxone.0.roomA.AI3.active': { val: false },
            'hue.0.rgb1.on': { val: false },
            'hue.0.rgb1.reachable': { val: true },
            'hue.0.ct2.on': { val: true },
            'hue.0.plug3.on': { val: false },
        };

        const recorded = {
            foreignStateWrites: [],
            httpCalls: [],
        };

        class FakeAdapter extends EventEmitter {
            constructor(opts) {
                super();
                this.name = opts.name;
                this.namespace = 'lox2hue.0';
                this.config = {
                    hueInstance: 'hue.0',
                    loxoneInstance: 'loxone.0',
                    hueBridgeHost: '127.0.0.1',
                    hueBridgePort: 443,
                    hueBridgeUser: 'test-token',
                    debounceMs: 200,
                    watchdogIntervalMin: 5,
                    onFadeMs: 700,
                    offFadeMs: 0,
                    settleMs: 8000,
                    dynamicGiveUpMs: 30000,
                    sceneMinLights: 2,
                    forceWarmWhiteMired: 454,
                    rgbBrightnessFactor: 1,
                    devices: [
                        { loxoneId: 'loxone.0.roomA.AI1', hueId: 'hue.0.rgb1', group: 'Raum A' },
                        { loxoneId: 'loxone.0.roomA.AI2', hueId: 'hue.0.ct2', group: 'Raum A' },
                        { loxoneId: 'loxone.0.roomA.AI3', hueId: 'hue.0.plug3', group: 'Raum A' },
                    ],
                };
                this.ownStates = {};
                this.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
            }
            setTimeout(fn, ms) {
                return setTimeout(fn, Math.min(ms, 2));
            }
            clearTimeout(t) {
                clearTimeout(t);
            }
            setInterval(fn, ms) {
                const t = setInterval(fn, ms);
                t.unref();
                return t;
            }
            clearInterval(t) {
                clearInterval(t);
            }
            async getForeignObjectAsync(id) {
                return foreignObjects[id] || null;
            }
            async getForeignStateAsync(id) {
                return foreignStates[id] || null;
            }
            async setForeignStateAsync(id, val, ack) {
                recorded.foreignStateWrites.push([id, val, ack]);
            }
            async subscribeForeignStatesAsync() {}
            async extendForeignObjectAsync() {}
            async setObjectNotExistsAsync() {}
            async getStateAsync(id) {
                return this.ownStates[id] || null;
            }
            async setStateAsync(id, val, ack) {
                this.ownStates[id] = { val, ack };
            }
            setState(id, val, ack) {
                this.ownStates[id] = { val, ack };
            }
        }

        let failNextScenePost = false;
        const createdScenes = [];

        https.request = (opts, cb) => {
            const req = new EventEmitter();
            let reqBody = '';
            req.write = c => {
                reqBody += c;
            };
            req.setTimeout = () => {};
            req.destroy = err => req.emit('error', err);
            req.end = () => {
                const parsedBody = reqBody ? JSON.parse(reqBody) : undefined;
                recorded.httpCalls.push({ method: opts.method, path: opts.path, body: parsedBody });
                let statusCode = 200;
                let respObj = { data: [], errors: [] };

                if (opts.path.endsWith('/scenes')) {
                    respObj = { old1: { type: 'LightScene', name: 'lx_old' }, usr: { type: 'GroupScene', name: 'U' } };
                } else if (opts.path.includes('/scenes/old1')) {
                    respObj = [{ success: 'deleted' }];
                } else if (opts.path === '/clip/v2/resource/light') {
                    respObj = {
                        data: [
                            {
                                id: 'v2-l1',
                                id_v1: '/lights/1',
                                dimming: { min_dim_level: 0.2 },
                                color: {},
                                color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
                            },
                            {
                                id: 'v2-l2',
                                id_v1: '/lights/2',
                                dimming: { min_dim_level: 1 },
                                color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 } },
                            },
                            { id: 'v2-l3', id_v1: '/lights/3' },
                        ],
                        errors: [],
                    };
                } else if (opts.path === '/clip/v2/resource/zone' && opts.method === 'POST') {
                    statusCode = 201;
                    respObj = { data: [{ rid: 'zone-1', rtype: 'zone' }], errors: [] };
                } else if (opts.path === '/clip/v2/resource/scene' && opts.method === 'GET') {
                    respObj = { data: createdScenes, errors: [] };
                } else if (opts.path === '/clip/v2/resource/scene' && opts.method === 'POST') {
                    if (failNextScenePost) {
                        failNextScenePost = false;
                        // Simulate bridge creating the scene right before client 504/timeout
                        createdScenes.push({
                            id: 'scene-recovered',
                            metadata: parsedBody.metadata,
                            group: parsedBody.group,
                        });
                        req.emit('error', new Error('Timeout'));
                        return;
                    }
                    statusCode = 201;
                    const sid = `scene-${createdScenes.length + 1}`;
                    createdScenes.push({ id: sid, metadata: parsedBody.metadata, group: parsedBody.group });
                    respObj = { data: [{ rid: sid, rtype: 'scene' }], errors: [] };
                } else if (opts.path.startsWith('/clip/v2/resource/scene/') && opts.method === 'PUT') {
                    respObj = { data: [{ rid: opts.path.split('/').pop(), rtype: 'scene' }], errors: [] };
                } else if (opts.path.startsWith('/clip/v2/resource/light/') && opts.method === 'PUT') {
                    respObj = { data: [{ rid: opts.path.split('/').pop(), rtype: 'light' }], errors: [] };
                }

                const res = new EventEmitter();
                res.statusCode = statusCode;
                cb(res);
                res.emit('data', JSON.stringify(respObj));
                res.emit('end');
            };
            return req;
        };

        Module._load = function (request) {
            if (request === '@iobroker/adapter-core') {
                return { Adapter: FakeAdapter };
            }
            return origLoad.apply(this, arguments);
        };

        return {
            foreignStates,
            recorded,
            setFailNextScenePost(v) {
                failNextScenePost = v;
            },
            cleanup() {
                https.request = origHttpsRequest;
                Module._load = origLoad;
            },
        };
    }

    it('cleans legacy v1 scenes, creates per-room CLIP v2 zone, learns & recalls scenes with echo suppression', async () => {
        const harness = createMockHarness();
        try {
            delete require.cache[require.resolve('../main.js')];
            const createAdapter = require('../main.js');
            const adapter = createAdapter();
            await adapter.onReady();

            // lastKnownOn initialized from hue.0.*.on (ct2 is initially on)
            expect(adapter.lastKnownOn.get('hue.0.ct2')).to.be.true;
            expect(adapter.lastKnownOn.get('hue.0.rgb1')).to.be.false;

            // Learn Mood 1
            harness.foreignStates['loxone.0.roomA.activeMoodsNum'].val = 1;
            harness.foreignStates['loxone.0.roomA.AI1.rgb'].val = '255,110,13';
            harness.foreignStates['loxone.0.roomA.AI2.position'].val = 60;
            harness.foreignStates['loxone.0.roomA.AI3.active'].val = true;
            adapter.onStateChange('loxone.0.roomA.activeMoodsNum', { val: 1 });
            adapter.onStateChange('loxone.0.roomA.AI1.rgb', { val: '255,110,13' });
            adapter.onStateChange('loxone.0.roomA.AI2.position', { val: 60 });
            adapter.onStateChange('loxone.0.roomA.AI3.active', { val: true });
            await new Promise(r => setTimeout(r, 30));

            const writesAfterLearn = harness.recorded.foreignStateWrites.length;
            expect(adapter.sceneCache.rooms['loxone.0.roomA']['1'].bridgeSceneId).to.equal('scene-1');

            // Switch to Mood 778 then back to Mood 1 -> single CLIP v2 scene recall + echo suppression
            harness.foreignStates['loxone.0.roomA.activeMoodsNum'].val = 778;
            adapter.onStateChange('loxone.0.roomA.activeMoodsNum', { val: 778 });
            await new Promise(r => setTimeout(r, 5));

            harness.foreignStates['loxone.0.roomA.activeMoodsNum'].val = 1;
            adapter.onStateChange('loxone.0.roomA.activeMoodsNum', { val: 1 });
            adapter.onStateChange('loxone.0.roomA.AI1.rgb', { val: '255,110,13' });
            adapter.onStateChange('loxone.0.roomA.AI2.position', { val: 60 });
            adapter.onStateChange('loxone.0.roomA.AI3.active', { val: true });
            await new Promise(r => setTimeout(r, 30));

            // Matching lamp updates during recall MUST NOT trigger individual Hue state writes
            expect(harness.recorded.foreignStateWrites.length).to.equal(writesAfterLearn);
            const recalls = harness.recorded.httpCalls.filter(
                c => c.method === 'PUT' && c.path === '/clip/v2/resource/scene/scene-1' && c.body?.recall,
            );
            expect(recalls).to.have.lengthOf(1);
            expect(recalls[0].body.recall).to.deep.equal({ action: 'active', duration: 700 });

            // Timeout recovery: if scene POST times out after bridge creation, deduplicate by name
            harness.setFailNextScenePost(true);
            harness.foreignStates['loxone.0.roomA.activeMoodsNum'].val = 2;
            harness.foreignStates['loxone.0.roomA.AI2.position'].val = 40;
            adapter.onStateChange('loxone.0.roomA.activeMoodsNum', { val: 2 });
            adapter.onStateChange('loxone.0.roomA.AI2.position', { val: 40 });
            await new Promise(r => setTimeout(r, 30));

            expect(adapter.sceneCache.rooms['loxone.0.roomA']['2'].bridgeSceneId).to.equal('scene-recovered');

            // Off watchdog skips rooms inside the 15s polling grace window, then corrects via CLIP v2 direct light PUT
            harness.foreignStates['loxone.0.roomA.AI1.rgb'].val = '0,0,0';
            harness.foreignStates['hue.0.rgb1.on'].val = true;
            await adapter.checkAndCorrectOff();
            expect(
                harness.recorded.httpCalls.filter(c => c.method === 'PUT' && c.path === '/clip/v2/resource/light/v2-l1'),
            ).to.have.lengthOf(0);

            adapter.roomGroups['loxone.0.roomA'].lastTransitionAt = Date.now() - 20000;
            await adapter.checkAndCorrectOff();
            const lightOffCalls = harness.recorded.httpCalls.filter(
                c => c.method === 'PUT' && c.path === '/clip/v2/resource/light/v2-l1',
            );
            expect(lightOffCalls).to.have.lengthOf(1);
            expect(lightOffCalls[0].body).to.deep.equal({ on: { on: false } });

            // Watchdog falls back to writing `<hueId>.on = false` when no CLIP v2 light entry exists
            adapter.v2LightsByV1Id.delete('1');
            await adapter.checkAndCorrectOff();
            expect(harness.recorded.foreignStateWrites.at(-1)).to.deep.equal(['hue.0.rgb1.on', false, false]);

            await new Promise(resolve => adapter.onUnload(resolve));
        } finally {
            harness.cleanup();
        }
    });
});

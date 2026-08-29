# ioBroker.lox2hue

[![NPM version](https://img.shields.io/npm/v/iobroker.lox2hue.svg)](https://www.npmjs.com/package/iobroker.lox2hue)

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/flohero)

Mirrors Loxone light-control moods (LightControllerV2) onto Philips Hue lamps. Loxone stays the master — every change on a configured Loxone output is forwarded immediately to the assigned Hue lamp.

## Why

Loxone handles automation (switches, moods, schedules); Hue handles the bulbs (color, tunable white). Normally these don't talk to each other. This adapter connects them: Loxone stays fully in charge, Hue just becomes the lamp that shows the result.

Switching many Hue lamps one command at a time makes them turn on visibly one after another — the bridge processes commands serially. A real Hue scene, by contrast, is a Zigbee broadcast: all lamps switch at once. So the adapter learns each room's Loxone mood and, once it has "settled" (a few seconds without further change), caches it as a hidden Hue bridge scene — the next trigger needs one bridge call instead of N.

Two cases are excluded from caching automatically:

- **Manual mode**: Loxone reports `activeMoodsNum < 0` when no defined mood matches exactly anymore.
- **Dynamic scenes** (e.g. "Party"): if a mood never settles within the configured time, it's marked dynamic and applied live instead.

## Features

- Per-room scene cache for near-simultaneous switching.
- Multiple Hue lamps on one Loxone output supported.
- Separate, configurable on/off fade time.
- Color temperature for white-ambiance lamps applied only on switch-on, so manual Hue-app adjustments aren't overwritten; RGB is approximated as color temperature when the paired lamp has no real color.
- Tradfri lamps driven via their own `.level`/`.ct` states (Kelvin, not mired).
- "Off" watchdog that corrects lamps drifted on outside Loxone's control.
- Auto-updating Loxone context display in the config table, with a manual refresh button.
- Bilingual admin UI (German/English, follows the ioBroker admin language).

## Requirements

- A [Loxone](https://www.loxone.com/) Miniserver with a LightControllerV2 block, and a running `iobroker.loxone` instance.
- A [Philips Hue](https://www.philips-hue.com/) bridge, and a running `iobroker.hue` instance (bridge IP/port picked up automatically).
- For scene acceleration: lamps belonging to a Loxone LightControllerV2 block (`moodList`/`activeMoodsNum`). Lamps without a mood concept still work via direct forwarding.

## Installation

Once accepted into the official ioBroker adapter catalog, install it from **Admin → Adapters** like any other adapter. Until then, see the repository's release page for the current status.

## Configuration

**Basic Settings tab**

1. Select the Hue and Loxone adapter instances.
2. Enter the Hue bridge API token by hand (in the Hue instance's config under "user" — protected, so it can't be read automatically). Bridge IP is taken from the Hue instance if left empty.
3. Adjust fine-tuning (fade times, batching window, off-check interval, scene settle time, fixed color temperature, brightness ceiling) if needed — defaults work for most setups.

**Lamps tab**

- **Loxone output**: the output block itself (e.g. "AI2"), not an individual value — the adapter picks `.rgb`/`.position`/`.active` automatically.
- **Loxone context**: read-only, shows group/name/detected type. Edit the group before the `::`; use **"Refresh Loxone context"** to update without restarting.
- **Hue lamp/group**: the target lamp or group.

## Known limitations

- Not yet an official ioBroker adapter catalog entry.
- Talks to the Hue bridge directly (bypassing `iobroker.hue`), since that adapter doesn't support scene management.
- Tested against Hue bridge API v1 (`apiversion` 1.78.0).
- RGB→color-temperature approximation (McCamy's formula) is not exact — saturated colors are clamped to a plausible range.

## Changelog

### 0.1.0 (2026-08-28)

- Initial public release: per-room/per-mood scene caching, multi-lamp Loxone outputs, configurable fade times, switch-on-only color temperature with RGB→mired approximation, Tradfri Kelvin handling, "off" watchdog, bilingual admin UI.

Older entries: see [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT

Copyright (c) 2026 Infi001

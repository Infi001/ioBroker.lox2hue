# ioBroker.lox2hue

[![NPM version](https://img.shields.io/npm/v/iobroker.lox2hue.svg)](https://www.npmjs.com/package/iobroker.lox2hue)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/flohero)

Mirrors Loxone light-control moods (LightControllerV2) onto Philips Hue lamps. Loxone stays the master — every change on a configured Loxone output is forwarded immediately to the assigned Hue lamp.

## Why

Switching many Hue lamps one command at a time makes them turn on visibly one after another, not simultaneously — the Hue bridge processes individual commands serially. A real Hue group/scene action, on the other hand, is a Zigbee broadcast: all affected lamps switch at the same instant.

This adapter therefore learns, per room (every Loxone light-control block detected via `activeMoodsNum`) and per mood, the target values of all assigned lamps. Once a mood has "settled" (a few seconds without further change), the adapter automatically creates its own hidden (`recycle`) Hue bridge scene for it. The next time that same mood is triggered, a single bridge call is enough instead of N individual commands.

Two cases are automatically excluded from caching, purely based on behavior, not naming:

- **Manual mode**: Loxone reports `activeMoodsNum < 0` whenever no defined mood matches exactly anymore (e.g. after manually readjusting a lamp).
- **Dynamic scenes** (e.g. "Party", "Wellness" with constantly changing colors): if a mood doesn't settle within the configured time, it's treated as dynamic and permanently excluded from caching — Loxone keeps driving it live.

## Features at a glance

- **Per-room scene cache** (see above) for near-simultaneous switching.
- **Multiple Hue lamps on one Loxone output** are correctly supported (e.g. two identical ceiling spots on a shared analog output) — all of them receive the command.
- **Separate on/off fade time** (in milliseconds), configurable per adapter instance.
- **Color temperature for white-ambiance lamps**: a fixed value is applied only on switch-on (never on a plain dim change), so later manual adjustments in the Hue app aren't constantly overwritten. If color info (RGB) is available from the Loxone output but the Hue lamp only supports color temperature (no real RGB), the color is automatically approximated as a color temperature.
- **Tradfri special case**: Tradfri lamps respond unreliably to the normal Hue `.command` path and are therefore driven via their own `.level`/`.ct` states (including the correct Kelvin, instead of mired, conversion for color temperature).
- **"Off" watchdog**: periodically checks whether lamps that should be off according to Loxone actually are, and corrects them if needed.
- **Automatically kept-up-to-date Loxone context display** in the configuration (shows group, Loxone name, and detected lamp type directly in the mapping table) plus a manual refresh button that works without an adapter restart.
- **Bilingual admin UI** (German/English, follows the ioBroker admin language setting).

## Requirements

- A running `iobroker.hue` adapter instance (local bridge access — `bridge`/`port` are picked up automatically).
- A running `iobroker.loxone` adapter instance.
- For scene acceleration: lamps that belong to a Loxone light-control block (LightControllerV2, with `moodList`/`activeMoodsNum`). Individual lamps without a mood concept also work — only direct forwarding applies there, no scene acceleration.

## Installation

Once accepted into the official ioBroker adapter catalog, install it from **Admin → Adapters** like any other adapter. Until then, see the repository's release page for the current status.

After installing, create an instance and configure it as described below.

## Configuration

**"Basic Settings" tab**

1. Select the **Hue adapter instance** and **Loxone adapter instance**.
2. Enter the **Hue bridge API token** (one-time, by hand — it's in the Hue adapter instance's configuration under "user", but that field is protected there and can't be picked up automatically). The bridge IP is taken automatically from the Hue adapter configuration if the field is left empty.
3. Adjust fine-tuning settings if needed (on/off fade time, batching window, off-check interval, scene settle time, fixed color temperature, brightness ceiling for color lamps, etc.) — each one has an explanatory help text, and the defaults work for most installations.

**"Lamps" tab**

Fill in the three-column table:

- **Loxone output**: select the light-control output block itself (e.g. "AI2"), not one of its individual values — the adapter automatically determines whether `.rgb`, `.position`, or `.active` is used, based on the detected Hue lamp type.
- **Loxone context**: informational only, not editable — shows group, Loxone name, and detected lamp type. The group is entered/changed directly in the first text section (before the `::`). After saving, use the **"Refresh Loxone context"** button to update it immediately, without restarting the adapter.
- **Hue lamp/group**: the associated Hue lamp or group.

## Known limitations

- Not yet an official ioBroker adapter catalog entry.
- Hue bridge access happens directly (bypassing `iobroker.hue`), since that adapter doesn't support scene management. Credentials are read live from its configuration.
- Tested against Hue bridge API v1 (CLIP v1, `apiversion` 1.78.0).
- The RGB→color-temperature approximation for white-ambiance lamps is an approximation (McCamy's formula), not an exact conversion — saturated colors (pure red/green/blue) have no physically meaningful color temperature, so the result is clamped to a plausible range.

## Changelog

### 0.1.0 (2026-08-28)

- Initial public release.
- Per-room/per-mood Hue scene caching for near-simultaneous switching.
- Support for multiple Hue lamps sharing one Loxone output.
- Configurable on/off fade times.
- Switch-on-only color-temperature forcing for white-ambiance lamps, with RGB→mired approximation when the Loxone output is a genuine color picker.
- Tradfri Kelvin/mired special-case handling.
- "Off" watchdog with periodic correction.
- Bilingual (German/English) admin UI with auto-refreshing Loxone context display.

## License

MIT

Copyright (c) 2026 f.herold@gmail.com

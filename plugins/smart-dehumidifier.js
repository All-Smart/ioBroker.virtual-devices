'use strict';

const { castToObjectType } = require('../lib/type-utils');

/**
 * Smart Dehumidifier plugin.
 *
 * Automates a dehumidifier by monitoring a humidity sensor, controlling a
 * power switch, and optionally detecting a full water tank via a power meter.
 *
 * ### Logic overview
 *
 * 1. When **enabled** and humidity > targetHumidity + hysteresis → turn ON
 * 2. When humidity < targetHumidity → turn OFF
 * 3. While the switch is ON and measured power drops below
 *    `tankFullPowerThreshold` for longer than `tankFullDelay` seconds →
 *    declare **tank full**, turn OFF
 * 4. When a user re-enables the device after a tank-full event → reset the
 *    alarm
 *
 * @module smart-dehumidifier
 */

// ---------------------------------------------------------------------------
// Internal per-device runtime state (not persisted)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DehumidifierState
 * @property {number|null} lowPowerSince   - Timestamp when low-power condition was first detected.
 * @property {boolean}     commandedOn     - Whether the switch was commanded ON by this plugin.
 * @property {ReturnType<typeof setInterval>|null} intervalHandle - Interval handle.
 */

/** @type {Map<string, DehumidifierState>} */
const runtimeState = new Map();

/**
 * @param {string} deviceId
 * @returns {DehumidifierState}
 */
function getRuntime(deviceId) {
    let s = runtimeState.get(deviceId);
    if (!s) {
        s = { lowPowerSince: null, commandedOn: false, intervalHandle: null };
        runtimeState.set(deviceId, s);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Time slot options for schedule selects (every 30 min)
// ---------------------------------------------------------------------------

/** @type {{ label: string, value: string }[]} */
const TIME_OPTIONS = [{ label: '—', value: '' }];
for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
        const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        TIME_OPTIONS.push({ label: t, value: t });
    }
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

class SmartDehumidifierPlugin {
    constructor() {
        // -- Identity ----------------------------------------------------------

        /** @type {string} */
        this.id = 'smart-dehumidifier';

        /** @type {Record<string,string>} */
        this.name = {
            en: 'Smart Dehumidifier',
            de: 'Intelligenter Entfeuchter',
        };

        /** @type {Record<string,string>} */
        this.description = {
            en: 'Automatic dehumidifier control with humidity target, tank-full detection, and power monitoring',
            de: 'Automatische Entfeuchtersteuerung mit Feuchtigkeitsziel, Tank-voll-Erkennung und Leistungsüberwachung',
        };

        /** @type {string} */
        this.icon = 'icons/smart-dehumidifier.svg';

        // -- Input slots -------------------------------------------------------

        /** @type {import('../lib/plugin-interface').InputSlot[]} */
        this.inputSlots = [
            {
                id: 'humiditySensor',
                name: { en: 'Humidity Sensor', de: 'Feuchtigkeitssensor' },
                description: {
                    en: 'The humidity sensor to monitor (e.g., from a Zigbee or Z-Wave sensor)',
                    de: 'Der zu überwachende Feuchtigkeitssensor (z.B. von einem Zigbee- oder Z-Wave-Sensor)',
                },
                required: true,
                filter: {
                    type: 'state',
                    common: {
                        type: 'number',
                        role: ['value.humidity'],
                    },
                },
            },
            {
                id: 'powerSwitch',
                name: { en: 'Power Switch', de: 'Netzschalter' },
                description: {
                    en: 'The switch that controls the dehumidifier power (on/off)',
                    de: 'Der Schalter, der den Entfeuchter ein-/ausschaltet',
                },
                required: true,
                filter: {
                    type: 'state',
                    common: {
                        type: 'boolean',
                        role: ['switch', 'switch.power'],
                    },
                },
            },
            {
                id: 'powerMeter',
                name: { en: 'Power Meter', de: 'Leistungsmesser' },
                description: {
                    en: 'Power consumption sensor for tank-full detection (optional but recommended)',
                    de: 'Leistungsverbrauchssensor für Tank-voll-Erkennung (optional, aber empfohlen)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: {
                        type: 'number',
                        role: ['value.power'],
                        unit: ['W'],
                    },
                },
            },
        ];

        // -- Config schema (JSONConfig fragments) ------------------------------

        /** @type {Record<string, import('../lib/plugin-interface').JsonConfigItem>} */
        this.configSchema = {
            targetHumidity: {
                type: 'number',
                label: { en: 'Target Humidity (%)', de: 'Ziel-Luftfeuchtigkeit (%)' },
                min: 30,
                max: 80,
            },
            humidityHysteresis: {
                type: 'number',
                label: { en: 'Hysteresis (%)', de: 'Hysterese (%)' },
                min: 1,
                max: 10,
            },
            tankFullPowerThreshold: {
                type: 'number',
                label: { en: 'Tank full power threshold (W)', de: 'Tank-voll Leistungsschwelle (W)' },
                min: 0,
                max: 50,
            },
            tankFullDelay: {
                type: 'number',
                label: { en: 'Tank full detection delay (s)', de: 'Tank-voll Erkennungsverzögerung (s)' },
                min: 10,
                max: 600,
            },
            scheduleMonStart: { type: 'select', label: { en: 'Mon from', de: 'Mo von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleMonEnd:   { type: 'select', label: { en: 'Mon until', de: 'Mo bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleTueStart: { type: 'select', label: { en: 'Tue from', de: 'Di von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleTueEnd:   { type: 'select', label: { en: 'Tue until', de: 'Di bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleWedStart: { type: 'select', label: { en: 'Wed from', de: 'Mi von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleWedEnd:   { type: 'select', label: { en: 'Wed until', de: 'Mi bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleThuStart: { type: 'select', label: { en: 'Thu from', de: 'Do von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleThuEnd:   { type: 'select', label: { en: 'Thu until', de: 'Do bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleFriStart: { type: 'select', label: { en: 'Fri from', de: 'Fr von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleFriEnd:   { type: 'select', label: { en: 'Fri until', de: 'Fr bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleSatStart: { type: 'select', label: { en: 'Sat from', de: 'Sa von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleSatEnd:   { type: 'select', label: { en: 'Sat until', de: 'Sa bis' }, options: TIME_OPTIONS, sm: 6 },
            scheduleSunStart: { type: 'select', label: { en: 'Sun from', de: 'So von' }, options: TIME_OPTIONS, sm: 6, newLine: true },
            scheduleSunEnd:   { type: 'select', label: { en: 'Sun until', de: 'So bis' }, options: TIME_OPTIONS, sm: 6 },
        };

        /** @type {Record<string, any>} */
        this.configDefaults = {
            targetHumidity: 55,
            humidityHysteresis: 3,
            tankFullPowerThreshold: 5,
            tankFullDelay: 60,
            scheduleMonStart: '', scheduleMonEnd: '',
            scheduleTueStart: '', scheduleTueEnd: '',
            scheduleWedStart: '', scheduleWedEnd: '',
            scheduleThuStart: '', scheduleThuEnd: '',
            scheduleFriStart: '', scheduleFriEnd: '',
            scheduleSatStart: '', scheduleSatEnd: '',
            scheduleSunStart: '', scheduleSunEnd: '',
        };

        // -- Output states -----------------------------------------------------

        /** @type {import('../lib/plugin-interface').OutputStateDefinition[]} */
        this.outputStates = [
            {
                id: 'running',
                name: { en: 'Running', de: 'Läuft' },
                type: 'boolean',
                role: 'indicator.working',
                read: true,
                write: false,
            },
            {
                id: 'humidity',
                name: { en: 'Humidity', de: 'Luftfeuchtigkeit' },
                type: 'number',
                role: 'value.humidity',
                unit: '%',
                read: true,
                write: false,
                min: 0,
                max: 100,
            },
            {
                id: 'power',
                name: { en: 'Power', de: 'Leistung' },
                type: 'number',
                role: 'value.power',
                unit: 'W',
                read: true,
                write: false,
                min: 0,
            },
            {
                id: 'tankFull',
                name: { en: 'Tank Full', de: 'Tank voll' },
                type: 'boolean',
                role: 'indicator.alarm',
                read: true,
                write: false,
            },
            {
                id: 'targetHumidity',
                name: { en: 'Target Humidity', de: 'Ziel-Luftfeuchtigkeit' },
                description: {
                    en: 'Target humidity level in percent',
                    de: 'Ziel-Luftfeuchtigkeit in Prozent',
                },
                type: 'number',
                role: 'level.humidity',
                unit: '%',
                read: true,
                write: true,
                min: 30,
                max: 80,
            },
            {
                id: 'enabled',
                name: { en: 'Automatic control', de: 'Automatische Steuerung' },
                description: {
                    en: 'Enable/disable automatic dehumidifier control',
                    de: 'Automatische Entfeuchtersteuerung ein-/ausschalten',
                },
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true,
            },
        ];
    }

    // ======================================================================
    // Lifecycle
    // ======================================================================

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async onInit(ctx) {
        const rt = getRuntime(ctx.deviceId);
        rt.lowPowerSince = null;
        rt.commandedOn = false;

        // Default output states
        await ctx.setOutputState('running', false, true);
        await ctx.setOutputState('tankFull', false, true);

        // Default enabled to true on first start if not yet set
        const enabledState = await ctx.getOutputState('enabled');
        if (enabledState === null || enabledState.val === null) {
            await ctx.setOutputState('enabled', true, true);
        }

        // Initialise targetHumidity output from config
        const targetHumidityState = await ctx.getOutputState('targetHumidity');
        if (targetHumidityState === null || targetHumidityState.val === null) {
            await ctx.setOutputState('targetHumidity', Number(ctx.config.targetHumidity ?? 55), true);
        }

        // Read current input values to initialise outputs
        const humState = await ctx.getInputState('humiditySensor');
        if (humState?.val !== null && humState?.val !== undefined) {
            await ctx.setOutputState('humidity', Number(humState.val), true);
        }

        const powerState = await ctx.getInputState('powerMeter');
        if (powerState?.val !== null && powerState?.val !== undefined) {
            await ctx.setOutputState('power', Number(powerState.val), true);
        }

        // Start periodic interval for tank-full detection
        rt.intervalHandle = setInterval(() => {
            this.onInterval(ctx).catch((e) => ctx.log.error(`Interval error: ${e}`));
        }, 10_000);

        // Evaluate initial humidity to turn on if already above threshold
        if (humState?.val !== null && humState?.val !== undefined) {
            await this._handleHumidityChange(ctx, Number(humState.val));
        }

        ctx.log.info(`Smart dehumidifier "${ctx.deviceId}" initialised`);
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {string} inputId
     * @param {object|null} state
     * @returns {Promise<void>}
     */
    async onInputChange(ctx, inputId, state) {
        if (!state || state.val === null || state.val === undefined) return;

        switch (inputId) {
            case 'humiditySensor':
                await this._handleHumidityChange(ctx, Number(state.val));
                break;

            case 'powerMeter':
                await this._handlePowerChange(ctx, Number(state.val));
                break;

            case 'powerSwitch':
                // Track external switch changes
                await ctx.setOutputState('running', Boolean(state.val), true);
                break;
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async onInterval(ctx) {
        const rt = getRuntime(ctx.deviceId);

        // Turn off if schedule window has ended
        if (rt.commandedOn && !this._isWithinSchedule(ctx)) {
            ctx.log.info(`Schedule window ended for "${ctx.deviceId}" — turning OFF`);
            await this._setSwitchState(ctx, false);
            return;
        }

        if (!rt.commandedOn) return;

        // Check for tank-full condition via sustained low power
        if (!ctx.inputs.powerMeter) return;

        const powerState = await ctx.getInputState('powerMeter');
        if (!powerState || powerState.val === null || powerState.val === undefined) return;

        const power = Number(powerState.val);
        const threshold = Number(ctx.config.tankFullPowerThreshold ?? 5);
        const delay = Number(ctx.config.tankFullDelay ?? 60) * 1000;

        if (power < threshold) {
            if (rt.lowPowerSince === null) {
                rt.lowPowerSince = Date.now();
            } else if (Date.now() - rt.lowPowerSince >= delay) {
                // Tank is full — set indicator only, do not turn off
                const currentTankFull = await ctx.getOutputState('tankFull');
                if (!currentTankFull?.val) {
                    ctx.log.warn(`Tank full detected for "${ctx.deviceId}" — power ${power}W below ${threshold}W for >${ctx.config.tankFullDelay}s`);
                    await ctx.setOutputState('tankFull', true, true);
                }
            }
        } else {
            rt.lowPowerSince = null;
            // Reset tankFull when power returns to normal
            const currentTankFull = await ctx.getOutputState('tankFull');
            if (currentTankFull?.val === true) {
                ctx.log.info(`Tank full cleared for "${ctx.deviceId}" — power back above threshold`);
                await ctx.setOutputState('tankFull', false, true);
            }
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async onDestroy(ctx) {
        const rt = runtimeState.get(ctx.deviceId);
        if (rt?.intervalHandle) {
            clearInterval(rt.intervalHandle);
        }
        runtimeState.delete(ctx.deviceId);
        ctx.log.info(`Smart dehumidifier "${ctx.deviceId}" destroyed`);
    }

    // ======================================================================
    // Private logic
    // ======================================================================

    /**
     * Check if the current time is within the configured schedule window.
     * Returns true if no schedule is configured (empty = 24/7).
     * Supports overnight windows (e.g. 22:00–06:00).
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {boolean}
     */
    /**
     * Per-day schedule check.
     * Each day has its own start/end time (HH:MM).
     * - Both empty for a day → that day has no restriction (24h).
     * - Both set → allowed only during that window.
     * - If ALL 7 days are empty → 24/7 (no restriction at all).
     * - A day with only start OR only end set → treated as no restriction for that day.
     * - If other days have times but today is empty → today is disabled.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {boolean}
     */
    _isWithinSchedule(ctx) {
        // Map JS getDay() (0=Sun..6=Sat) to config key prefixes
        const dayPrefixes = ['scheduleSun', 'scheduleMon', 'scheduleTue', 'scheduleWed', 'scheduleThu', 'scheduleFri', 'scheduleSat'];
        const now = new Date();
        const todayPrefix = dayPrefixes[now.getDay()];

        const todayStart = String(ctx.config[`${todayPrefix}Start`] || '').trim();
        const todayEnd = String(ctx.config[`${todayPrefix}End`] || '').trim();

        ctx.log.debug(`Schedule check: day=${now.getDay()} (${todayPrefix}), start="${todayStart}", end="${todayEnd}", time=${now.getHours()}:${now.getMinutes()}`);

        // Check if ANY day has a schedule configured
        const anyDayConfigured = dayPrefixes.some((prefix) => {
            const s = String(ctx.config[`${prefix}Start`] || '').trim();
            const e = String(ctx.config[`${prefix}End`] || '').trim();
            return s !== '' && e !== '';
        });

        // No day has a schedule → 24/7
        if (!anyDayConfigured) return true;

        // Other days have schedules but today has none → today is disabled
        if (!todayStart || !todayEnd) return false;

        // Today has a schedule → check time window
        const match = (s) => s.match(/^(\d{1,2}):(\d{2})$/);
        const startMatch = match(todayStart);
        const endMatch = match(todayEnd);
        if (!startMatch || !endMatch) return true; // invalid format → allow

        const currentMin = now.getHours() * 60 + now.getMinutes();
        const startMin = parseInt(startMatch[1], 10) * 60 + parseInt(startMatch[2], 10);
        const endMin = parseInt(endMatch[1], 10) * 60 + parseInt(endMatch[2], 10);

        if (startMin <= endMin) {
            return currentMin >= startMin && currentMin < endMin;
        } else {
            // Overnight: e.g. 22:00–06:00
            return currentMin >= startMin || currentMin < endMin;
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {number} humidity
     * @returns {Promise<void>}
     */
    async _handleHumidityChange(ctx, humidity) {
        await ctx.setOutputState('humidity', humidity, true);

        const enabled = await ctx.getOutputState('enabled');
        if (!enabled || enabled.val !== true) {
            ctx.log.debug(`Humidity change ignored: enabled=${enabled?.val}`);
            return;
        }

        // tankFull is now indicator-only, does not block control logic

        // Prefer runtime targetHumidity output state over config (allows Alexa/Google Home control)
        const targetState = await ctx.getOutputState('targetHumidity');
        const target = (targetState?.val !== null && targetState?.val !== undefined)
            ? Number(targetState.val)
            : Number(ctx.config.targetHumidity ?? 55);
        const hysteresis = Number(ctx.config.humidityHysteresis ?? 3);
        const rt = getRuntime(ctx.deviceId);
        const inSchedule = this._isWithinSchedule(ctx);

        ctx.log.debug(`Humidity check: ${humidity}% vs ${target}+${hysteresis}=${target + hysteresis}%, commandedOn=${rt.commandedOn}, inSchedule=${inSchedule}`);

        if (humidity > target + hysteresis && !rt.commandedOn && inSchedule) {
            ctx.log.info(`Humidity ${humidity}% > ${target + hysteresis}% — turning ON`);
            await this._setSwitchState(ctx, true);
        } else if (humidity < target && rt.commandedOn) {
            ctx.log.info(`Humidity ${humidity}% < ${target}% — turning OFF`);
            await this._setSwitchState(ctx, false);
        } else if (!inSchedule && rt.commandedOn) {
            ctx.log.info(`Outside schedule window — turning OFF`);
            await this._setSwitchState(ctx, false);
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {number} power
     * @returns {Promise<void>}
     */
    async _handlePowerChange(ctx, power) {
        await ctx.setOutputState('power', power, true);

        const rt = getRuntime(ctx.deviceId);
        const threshold = Number(ctx.config.tankFullPowerThreshold ?? 5);

        // Reset low-power timer if power is above threshold
        if (power >= threshold) {
            rt.lowPowerSince = null;
        }
    }

    /**
     * Command the physical power switch and update runtime/output state.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} on
     * @returns {Promise<void>}
     */
    async _setSwitchState(ctx, on) {
        const rt = getRuntime(ctx.deviceId);
        rt.commandedOn = on;

        if (ctx.inputs.powerSwitch) {
            const valCast = await castToObjectType(ctx.adapter, ctx.inputs.powerSwitch, on, ctx.log);
            await ctx.adapter.setForeignStateAsync(ctx.inputs.powerSwitch, valCast, false);
        }

        await ctx.setOutputState('running', on, true);

        if (!on) {
            rt.lowPowerSince = null;
        }
    }
}

module.exports = { SmartDehumidifierPlugin };

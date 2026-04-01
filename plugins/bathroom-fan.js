'use strict';

/**
 * Bathroom Fan plugin.
 *
 * Automates a bathroom exhaust fan based on humidity and presence+door conditions.
 *
 * ### Logic overview
 *
 * 1. **Humidity trigger:** When humidity > threshold → fan ON. When humidity < threshold - hysteresis → fan OFF.
 * 2. **Presence trigger:** When presence == activeValue AND door == closedValue → fan ON.
 *    When either condition breaks → fan OFF.
 * 3. **Priority:** If both triggers are active, the ON chain runs (single chain for both triggers).
 * 4. **Off-delay:** After all triggers clear, the fan runs for `offDelay` more seconds.
 *
 * The ON and OFF action chains define which datapoints get written (and with which value).
 * Configure at least one step in each chain — typically your fan’s switch/level datapoint.
 *
 * All actuator values are configurable (no boolean/type assumptions).
 *
 * @module bathroom-fan
 */

// ---------------------------------------------------------------------------
// Per-device runtime state (not persisted across restarts)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FanRuntime
 * @property {boolean}     humidityTrigger  - Humidity condition is active.
 * @property {boolean}     presenceTrigger  - Presence+door condition is active.
 * @property {ReturnType<typeof setTimeout>|null} offTimer - Delayed-off timer handle.
 * @property {boolean|null} lastCommandWasOn - Whether the last command turned the fan on.
 * @property {import('../lib/action-chain').ActionChainExecutor|null} activeChainExecutor - Currently running chain.
 */

/** @type {Map<string, FanRuntime>} */
const runtimeState = new Map();

/**
 * @param {string} deviceId
 * @returns {FanRuntime}
 */
function getRuntime(deviceId) {
    let s = runtimeState.get(deviceId);
    if (!s) {
        s = { humidityTrigger: false, presenceTrigger: false, offTimer: null, lastCommandWasOn: null, activeChainExecutor: null };
        runtimeState.set(deviceId, s);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loose comparison that handles string/number/boolean mixing from config values.
 * Handles cases like boolean `true` vs string `'true'`, number `1` vs string `'1'`, etc.
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
/**
 * Parse a config value string into its native type.
 * 'true'/'false' → boolean, numeric strings → number, otherwise string as-is.
 * @param {any} val
 * @returns {any}
 */
function parseConfigValue(val) {
    if (val === '' || val === null || val === undefined) return val;
    const s = String(val).trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    const n = Number(val);
    if (!isNaN(n) && String(val).trim() !== '') return n;
    return String(val);
}

function looseEquals(actual, expected) {
    // eslint-disable-next-line eqeqeq
    if (actual == expected) return true;
    // Handle boolean<->string: true/'true', false/'false'
    const strActual = String(actual).toLowerCase();
    const strExpected = String(expected).toLowerCase();
    return strActual === strExpected;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class BathroomFanPlugin {
    constructor() {
        /** @type {string} */
        this.id = 'bathroom-fan';

        /** @type {Record<string,string>} */
        this.name = {
            en: 'Bathroom Fan',
            de: 'Badlüfter',
        };

        /** @type {Record<string,string>} */
        this.description = {
            en: 'Automatic bathroom fan control based on humidity and presence with configurable actuator values',
            de: 'Automatische Badlüfter-Steuerung über Feuchtigkeit und Präsenz mit konfigurierbaren Aktor-Werten',
        };

        /** @type {string} */
        this.icon = 'icons/bathroom-fan.svg';

        // -- Input slots -------------------------------------------------------

        /** @type {import('../lib/plugin-interface').InputSlot[]} */
        this.inputSlots = [
            {
                id: 'humiditySensor',
                name: { en: 'Humidity Sensor', de: 'Feuchtigkeitssensor' },
                description: {
                    en: 'Humidity sensor in the bathroom (%)',
                    de: 'Feuchtigkeitssensor im Bad (%)',
                },
                required: true,
                filter: {
                    type: 'state',
                    common: { type: 'number', role: ['value.humidity'] },
                },
            },
            {
                id: 'fanStatus',
                name: { en: 'Fan Status', de: 'Lüfter Status' },
                description: {
                    en: 'Status datapoint that reports the current fan state (read)',
                    de: 'Status-Datenpunkt der den aktuellen Lüfter-Zustand meldet (lesend)',
                },
                required: false,
                filter: { type: 'state' },
            },
            {
                id: 'presenceSensor',
                name: { en: 'Presence Sensor', de: 'Präsenzmelder' },
                description: {
                    en: 'Presence/motion sensor in the bathroom (optional)',
                    de: 'Präsenz-/Bewegungsmelder im Bad (optional)',
                },
                required: false,
                filter: { type: 'state' },
            },
            {
                id: 'doorContact',
                name: { en: 'Door Contact', de: 'Türkontakt' },
                description: {
                    en: 'Door contact sensor (optional, needed for presence trigger)',
                    de: 'Türkontakt-Sensor (optional, nötig für Präsenz-Trigger)',
                },
                required: false,
                filter: { type: 'state' },
            },
        ];

        // -- Config schema -----------------------------------------------------

        /** @type {Record<string, import('../lib/plugin-interface').JsonConfigItem>} */
        this.configSchema = {
            humidityThreshold: {
                type: 'number',
                label: { en: 'Humidity Threshold (%)', de: 'Feuchtigkeitsschwelle (%)' },
                min: 30,
                max: 95,
            },
            humidityHysteresis: {
                type: 'number',
                label: { en: 'Hysteresis (%)', de: 'Hysterese (%)' },
                min: 1,
                max: 20,
            },
            statusOnValue: {
                type: 'text',
                label: { en: 'Status ON value', de: 'Status AN Wert' },
            },
            statusOffValue: {
                type: 'text',
                label: { en: 'Status OFF value', de: 'Status AUS Wert' },
            },
            presenceActiveValue: {
                type: 'text',
                label: { en: 'Presence active value', de: 'Präsenz aktiv Wert' },
            },
            doorClosedValue: {
                type: 'text',
                label: { en: 'Door closed value', de: 'Tür geschlossen Wert' },
            },
            offDelay: {
                type: 'number',
                label: { en: 'Off delay (seconds)', de: 'Nachlaufzeit (Sekunden)' },
                min: 0,
                max: 3600,
            },
        };

        /** @type {Record<string, any>} */
        this.configDefaults = {
            humidityThreshold: 65,
            humidityHysteresis: 5,
            statusOnValue: '1',
            statusOffValue: '0',
            presenceActiveValue: 'true',
            doorClosedValue: 'false',
            offDelay: 120,
        };

        // -- Action chain slots ------------------------------------------------

        /** @type {Record<string, import('../lib/plugin-interface').ActionChainSlot>} */
        this.actionChainSlots = {
            on: {
                name: { en: 'ON Chain', de: 'AN-Kette' },
                description: {
                    en: 'Datapoints to set when the fan turns on. Add one row per datapoint — e.g. your fan channel with value 1. Steps are executed in order.',
                    de: 'Datenpunkte die beim Einschalten gesetzt werden. Pro Zeile ein Datenpunkt — z.B. den Lüfter-Kanal mit Wert 1. Schritte werden der Reihe nach ausgeführt.',
                },
            },
            off: {
                name: { en: 'OFF Chain', de: 'AUS-Kette' },
                description: {
                    en: 'Datapoints to set when the fan turns off (after the off-delay). Add one row per datapoint — e.g. your fan channel with value 0.',
                    de: 'Datenpunkte die beim Ausschalten gesetzt werden (nach der Nachlaufzeit). Pro Zeile ein Datenpunkt — z.B. den Lüfter-Kanal mit Wert 0.',
                },
            },
        };

        // -- Output states -----------------------------------------------------

        /** @type {import('../lib/plugin-interface').OutputStateDefinition[]} */
        this.outputStates = [
            {
                id: 'active',
                name: { en: 'Active', de: 'Aktiv' },
                type: 'boolean',
                role: 'indicator.working',
                read: true,
                write: false,
            },
            {
                id: 'trigger',
                name: { en: 'Trigger', de: 'Auslöser' },
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            {
                id: 'enabled',
                name: { en: 'Automatic control', de: 'Automatische Steuerung' },
                description: {
                    en: 'Enable/disable automatic fan control',
                    de: 'Automatische Lüftersteuerung ein-/ausschalten',
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
        rt.humidityTrigger = false;
        rt.presenceTrigger = false;
        rt.offTimer = null;
        rt.lastCommandWasOn = null;

        // Default output states
        await ctx.setOutputState('active', false, true);
        await ctx.setOutputState('trigger', 'none', true);

        const enabledState = await ctx.getOutputState('enabled');
        if (enabledState === null || enabledState.val === null) {
            await ctx.setOutputState('enabled', true, true);
        }

        // Evaluate current inputs on start
        const humState = await ctx.getInputState('humiditySensor');
        if (humState?.val !== null && humState?.val !== undefined) {
            await this._evaluateHumidity(ctx, Number(humState.val));
        }

        await this._evaluatePresence(ctx);
        await this._applyDesiredState(ctx);

        ctx.log.info(`Bathroom fan "${ctx.deviceId}" initialised`);
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {string} inputId
     * @param {object|null} state
     * @returns {Promise<void>}
     */
    async onInputChange(ctx, inputId, state) {
        if (!state || state.val === null || state.val === undefined) return;

        const enabled = await ctx.getOutputState('enabled');
        if (!enabled || enabled.val !== true) {
            ctx.log.debug(`Input change ignored (disabled): ${inputId}`);
            return;
        }

        switch (inputId) {
            case 'humiditySensor':
                await this._evaluateHumidity(ctx, Number(state.val));
                break;
            case 'presenceSensor':
            case 'doorContact':
                await this._evaluatePresence(ctx);
                break;
            case 'fanStatus': // optional — reflects real hardware state, no command logic
                await this._updateActiveState(ctx, state.val);
                return;
        }

        await this._applyDesiredState(ctx);
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {string} outputId
     * @param {any} value
     * @returns {Promise<void>}
     */
    async onOutputWrite(ctx, outputId, value) {
        if (outputId === 'enabled') {
            await ctx.setOutputState('enabled', Boolean(value), true);
            ctx.log.info(`Automatic control ${value ? 'enabled' : 'disabled'} for "${ctx.deviceId}"`);

            if (!value) {
                // Disabled — cancel pending off-timer
                const rt = getRuntime(ctx.deviceId);
                if (rt.offTimer) {
                    clearTimeout(rt.offTimer);
                    rt.offTimer = null;
                }
            } else {
                // Re-enabled — re-evaluate
                const humState = await ctx.getInputState('humiditySensor');
                if (humState?.val !== null && humState?.val !== undefined) {
                    await this._evaluateHumidity(ctx, Number(humState.val));
                }
                await this._evaluatePresence(ctx);
                await this._applyDesiredState(ctx);
            }
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async onDestroy(ctx) {
        const rt = runtimeState.get(ctx.deviceId);
        if (rt?.offTimer) {
            clearTimeout(rt.offTimer);
        }
        if (rt?.activeChainExecutor) {
            rt.activeChainExecutor.abort();
        }
        runtimeState.delete(ctx.deviceId);
        ctx.log.info(`Bathroom fan "${ctx.deviceId}" destroyed`);
    }

    // ======================================================================
    // Private logic
    // ======================================================================

    /**
     * Evaluate humidity against threshold/hysteresis and set trigger flag.
     * Does NOT send commands — call _applyDesiredState afterwards.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {number} humidity
     */
    async _evaluateHumidity(ctx, humidity) {
        const rt = getRuntime(ctx.deviceId);
        const threshold = Number(ctx.config.humidityThreshold ?? 65);
        const hysteresis = Number(ctx.config.humidityHysteresis ?? 5);

        if (humidity > threshold && !rt.humidityTrigger) {
            ctx.log.info(`Humidity ${humidity}% > ${threshold}% — humidity trigger ON`);
            rt.humidityTrigger = true;
        } else if (humidity < (threshold - hysteresis) && rt.humidityTrigger) {
            ctx.log.info(`Humidity ${humidity}% < ${threshold - hysteresis}% — humidity trigger OFF`);
            rt.humidityTrigger = false;
        }
    }

    /**
     * Evaluate presence + door state and set trigger flag.
     * Does NOT send commands — call _applyDesiredState afterwards.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     */
    async _evaluatePresence(ctx) {
        const rt = getRuntime(ctx.deviceId);

        // Both inputs must be mapped for presence trigger
        if (!ctx.inputs.presenceSensor || !ctx.inputs.doorContact) {
            rt.presenceTrigger = false;
            return;
        }

        const presenceState = await ctx.getInputState('presenceSensor');
        const doorState = await ctx.getInputState('doorContact');

        if (!presenceState || presenceState.val === null || !doorState || doorState.val === null) {
            rt.presenceTrigger = false;
            return;
        }

        const presenceActive = looseEquals(presenceState.val, ctx.config.presenceActiveValue ?? 'true');
        const doorClosed = looseEquals(doorState.val, ctx.config.doorClosedValue ?? 'false');

        const wasActive = rt.presenceTrigger;
        rt.presenceTrigger = presenceActive && doorClosed;

        if (rt.presenceTrigger && !wasActive) {
            ctx.log.info(`Presence + door closed — presence trigger ON`);
        } else if (!rt.presenceTrigger && wasActive) {
            ctx.log.info(`Presence/door condition cleared — presence trigger OFF`);
        }
    }

    /**
     * Determine the desired fan command value based on active triggers and send it.
     * Handles off-delay when all triggers clear.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     */
    async _applyDesiredState(ctx) {
        const rt = getRuntime(ctx.deviceId);
        const offDelay = Number(ctx.config.offDelay ?? 120) * 1000;

        // Determine desired state
        let wantOn = false;
        let triggerName = 'none';

        if (rt.humidityTrigger && rt.presenceTrigger) {
            triggerName = 'both';
            wantOn = true;
        } else if (rt.humidityTrigger) {
            triggerName = 'humidity';
            wantOn = true;
        } else if (rt.presenceTrigger) {
            triggerName = 'presence';
            wantOn = true;
        }

        await ctx.setOutputState('trigger', triggerName, true);

        if (wantOn) {
            // Cancel any pending off-timer
            if (rt.offTimer) {
                clearTimeout(rt.offTimer);
                rt.offTimer = null;
            }

            await this._sendFanCommand(ctx, true);
        } else {
            // All triggers off — start off-delay (or turn off immediately if delay=0)
            if (rt.lastCommandWasOn !== false) {
                if (rt.offTimer) return; // Already waiting

                if (offDelay <= 0) {
                    await this._sendFanCommand(ctx, false);
                } else {
                    ctx.log.info(`All triggers cleared — off-delay ${offDelay / 1000}s started`);
                    rt.offTimer = setTimeout(async () => {
                        rt.offTimer = null;
                        // Re-check triggers (they may have re-activated during delay)
                        if (!rt.humidityTrigger && !rt.presenceTrigger) {
                            ctx.log.info(`Off-delay elapsed — turning fan OFF`);
                            await this._sendFanCommand(ctx, false);
                            await ctx.setOutputState('trigger', 'none', true);
                        }
                    }, offDelay);
                }
            }
        }
    }

    /**
     * Execute the ON or OFF action chain.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} on - true = execute ON chain, false = execute OFF chain.
     */
    async _sendFanCommand(ctx, on) {
        const rt = getRuntime(ctx.deviceId);

        if (rt.lastCommandWasOn === on) return; // No change needed

        // Abort any running chain before starting a new one
        if (rt.activeChainExecutor) {
            rt.activeChainExecutor.abort();
            rt.activeChainExecutor = null;
        }

        rt.lastCommandWasOn = on;

        const chain = this._buildChain(ctx, on);

        if (chain.length === 0) {
            ctx.log.warn(`Fan "${ctx.deviceId}": ${on ? 'ON' : 'OFF'} chain is empty — no datapoints configured. Nothing sent.`);
            await ctx.setOutputState('active', on, true);
            return;
        }

        if (typeof ctx.executeChain === 'function') {
            try {
                rt.activeChainExecutor = await ctx.executeChain(chain);
            } catch (e) {
                if (e.message && e.message.includes('aborted')) {
                    ctx.log.debug('Fan command chain was aborted');
                    return;
                }
                ctx.log.error(`Fan command chain failed: ${e}`);
            } finally {
                rt.activeChainExecutor = null;
            }
        }

        await ctx.setOutputState('active', on, true);
        ctx.log.info(`Fan ${on ? 'ON' : 'OFF'} chain executed`);
    }

    /**
     * Return the configured ON or OFF action chain.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} on
     * @returns {import('../lib/plugin-interface').ActionChain}
     */
    _buildChain(ctx, on) {
        const slotId = on ? 'on' : 'off';
        if (ctx.chains && Array.isArray(ctx.chains[slotId])) {
            return ctx.chains[slotId];
        }
        return [];
    }

    /**
     * Update active output state based on fanStatus reading.
     * fanStatus is optional — it reflects the real hardware state back into the virtual device.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {any} statusVal
     */
    async _updateActiveState(ctx, statusVal) {
        const isOn = !looseEquals(statusVal, ctx.config.statusOffValue ?? '0');
        await ctx.setOutputState('active', isOn, true);
    }
}

module.exports = { BathroomFanPlugin };

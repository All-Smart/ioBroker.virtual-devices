'use strict';

const { castToObjectType } = require('../lib/type-utils');

/**
 * Home Cinema plugin.
 *
 * Orchestrates a complete home cinema setup (display, screen, amplifier,
 * media source) as a single virtual device with standardised ioBroker roles
 * for widget and voice assistant compatibility.
 *
 * ### Architecture
 *
 * The plugin itself contains NO hardware-specific logic.  All startup/shutdown
 * sequences are user-configured via **Action Chains**.  The plugin provides:
 *
 * 1. **Output states** with proper roles (`switch`, `level.volume`, `media.mute`,
 *    `media.state`) so Alexa, Google Home, and VIS widgets work out of the box.
 * 2. **Volume pass-through** — volume changes on the virtual device are forwarded
 *    to the amplifier; the media source volume is auto-set on startup to ensure
 *    the amplifier always receives a strong enough signal.
 * 3. **State machine** (`off` → `starting` → `on` → `stopping` → `off`) with
 *    timeout protection for long chains.
 * 4. **Screen control** — independently controllable (separate from power),
 *    useful when you only want the screen for a presentation without full cinema.
 *
 * ### Typical setup (example)
 *
 * powerOn chain:
 *   1. SET smart plug (amplifier) → true
 *   2. WAIT 15s (amplifier boots)
 *   3. SET amplifier input → "AUX"
 *   4. SET media source volume → 90
 *   5. SET motorised screen → down
 *   6. SET beamer power → true
 *
 * powerOff chain:
 *   1. SET beamer power → false
 *   2. SET screen → up
 *   3. WAIT 3s
 *   4. SET smart plug (amplifier) → false
 *
 * @module home-cinema
 */

// ---------------------------------------------------------------------------
// Per-device runtime state (not persisted across restarts)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CinemaRuntime
 * @property {'off'|'starting'|'on'|'stopping'} state - Current state machine position.
 * @property {import('../lib/action-chain').ActionChainExecutor|null} activeChainExecutor - Currently running chain.
 * @property {ReturnType<typeof setTimeout>|null} startupTimer - Timeout guard for startup.
 * @property {ReturnType<typeof setTimeout>|null} shutdownTimer - Timeout guard for shutdown.
 */

/** @type {Map<string, CinemaRuntime>} */
const runtimeState = new Map();

/**
 * @param {string} deviceId
 * @returns {CinemaRuntime}
 */
function getRuntime(deviceId) {
    let s = runtimeState.get(deviceId);
    if (!s) {
        s = { state: 'off', activeChainExecutor: null, startupTimer: null, shutdownTimer: null };
        runtimeState.set(deviceId, s);
    }
    return s;
}

/**
 * Parse a config value string into its native type.
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class HomeCinemaPlugin {
    constructor() {
        /** @type {string} */
        this.id = 'home-cinema';

        /** @type {Record<string,string>} */
        this.name = {
            en: 'Home Cinema',
            de: 'Heimkino',
        };

        /** @type {Record<string,string>} */
        this.description = {
            en: 'Orchestrates display, screen, amplifier, and media source as a single cinema device with voice assistant support',
            de: 'Orchestriert Display, Leinwand, Verstärker und Medienquelle als einzelnes Kino-Gerät mit Sprachassistenten-Unterstützung',
        };

        /** @type {string} */
        this.icon = 'icons/home-cinema.svg';

        // -- Input slots -------------------------------------------------------

        /** @type {import('../lib/plugin-interface').InputSlot[]} */
        this.inputSlots = [
            {
                id: 'amplifierVolume',
                name: { en: 'Amplifier Volume', de: 'Verstärker Lautstärke' },
                description: {
                    en: 'Volume control datapoint of the amplifier (0-100)',
                    de: 'Lautstärke-Datenpunkt des Verstärkers (0-100)',
                },
                required: true,
                filter: {
                    type: 'state',
                    common: { type: 'number', role: ['level.volume'] },
                },
            },
            {
                id: 'amplifierMute',
                name: { en: 'Amplifier Mute', de: 'Verstärker Stumm' },
                description: {
                    en: 'Mute control of the amplifier (optional)',
                    de: 'Stummschaltung des Verstärkers (optional)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'boolean' },
                },
            },
            {
                id: 'amplifierPower',
                name: { en: 'Amplifier Power Status', de: 'Verstärker Power Status' },
                description: {
                    en: 'Power state feedback from the amplifier (read, optional)',
                    de: 'Power-Status-Rückmeldung vom Verstärker (lesend, optional)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'boolean' },
                },
            },
            {
                id: 'displayPower',
                name: { en: 'Display Power Status', de: 'Display Power Status' },
                description: {
                    en: 'Power state feedback from the display/beamer (read, optional)',
                    de: 'Power-Status-Rückmeldung vom Display/Beamer (lesend, optional)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'boolean' },
                },
            },
            {
                id: 'screenPosition',
                name: { en: 'Screen Position', de: 'Leinwand Position' },
                description: {
                    en: 'Current position of the motorised screen (read, optional)',
                    de: 'Aktuelle Position der Motorleinwand (lesend, optional)',
                },
                required: false,
                filter: {
                    type: 'state',
                },
            },
            {
                id: 'sourceVolume',
                name: { en: 'Source Volume', de: 'Quell-Lautstärke' },
                description: {
                    en: 'Volume of the media source (e.g. Android TV) — auto-set on startup to ensure signal strength',
                    de: 'Lautstärke der Medienquelle (z.B. Android TV) — wird beim Start automatisch gesetzt für ausreichende Signalstärke',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'number' },
                },
            },
            {
                id: 'triggerPowerOn',
                name: { en: 'Trigger Power ON', de: 'Trigger Einschalten' },
                description: {
                    en: 'A button or switch datapoint that triggers power-on when set to true (e.g. remote control button)',
                    de: 'Ein Taster oder Schalter-Datenpunkt, der beim Setzen auf true das Einschalten auslöst (z.B. Fernbedienungs-Taste)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'boolean' },
                },
            },
            {
                id: 'triggerPowerOff',
                name: { en: 'Trigger Power OFF', de: 'Trigger Ausschalten' },
                description: {
                    en: 'A button or switch datapoint that triggers power-off when set to true (e.g. remote control button)',
                    de: 'Ein Taster oder Schalter-Datenpunkt, der beim Setzen auf true das Ausschalten auslöst (z.B. Fernbedienungs-Taste)',
                },
                required: false,
                filter: {
                    type: 'state',
                    common: { type: 'boolean' },
                },
            },
        ];

        // -- Config schema -----------------------------------------------------

        /** @type {Record<string, import('../lib/plugin-interface').JsonConfigItem>} */
        this.configSchema = {
            volumeDefault: {
                type: 'number',
                label: { en: 'Default Volume (%)', de: 'Standard-Lautstärke (%)' },
                min: 0,
                max: 100,
            },
            sourceVolumeMin: {
                type: 'number',
                label: { en: 'Source minimum volume (%)', de: 'Quell-Mindestlautstärke (%)' },
                min: 0,
                max: 100,
            },
            startupTimeout: {
                type: 'number',
                label: { en: 'Startup timeout (seconds)', de: 'Startup-Timeout (Sekunden)' },
                min: 10,
                max: 300,
            },
            shutdownTimeout: {
                type: 'number',
                label: { en: 'Shutdown timeout (seconds)', de: 'Shutdown-Timeout (Sekunden)' },
                min: 5,
                max: 120,
            },
            screenDownValue: {
                type: 'text',
                label: { en: 'Screen DOWN value', de: 'Leinwand RUNTER Wert' },
            },
            screenUpValue: {
                type: 'text',
                label: { en: 'Screen UP value', de: 'Leinwand HOCH Wert' },
            },
        };

        /** @type {Record<string, any>} */
        this.configDefaults = {
            volumeDefault: 30,
            sourceVolumeMin: 90,
            startupTimeout: 60,
            shutdownTimeout: 30,
            screenDownValue: '0',
            screenUpValue: '100',
        };

        // -- Action chain slots ------------------------------------------------

        /** @type {Record<string, import('../lib/plugin-interface').ActionChainSlot>} */
        this.actionChainSlots = {
            powerOn: {
                name: { en: 'Power ON Chain', de: 'Einschalt-Kette' },
                description: {
                    en: 'Sequential commands to power on the entire cinema (amplifier → input → source volume → screen → display)',
                    de: 'Sequentielle Befehle zum Einschalten des gesamten Kinos (Verstärker → Eingang → Quell-Lautstärke → Leinwand → Display)',
                },
            },
            powerOff: {
                name: { en: 'Power OFF Chain', de: 'Ausschalt-Kette' },
                description: {
                    en: 'Sequential commands to power off the cinema (display → screen → amplifier)',
                    de: 'Sequentielle Befehle zum Ausschalten des Kinos (Display → Leinwand → Verstärker)',
                },
            },
            screenDown: {
                name: { en: 'Screen DOWN Chain', de: 'Leinwand RUNTER Kette' },
                description: {
                    en: 'Commands to lower the screen (optional, for independent screen control)',
                    de: 'Befehle zum Herunterfahren der Leinwand (optional, für unabhängige Leinwandsteuerung)',
                },
            },
            screenUp: {
                name: { en: 'Screen UP Chain', de: 'Leinwand HOCH Kette' },
                description: {
                    en: 'Commands to raise the screen (optional, for independent screen control)',
                    de: 'Befehle zum Hochfahren der Leinwand (optional, für unabhängige Leinwandsteuerung)',
                },
            },
        };

        // -- Output states -----------------------------------------------------

        /** @type {import('../lib/plugin-interface').OutputStateDefinition[]} */
        this.outputStates = [
            {
                id: 'power',
                name: { en: 'Power', de: 'Power' },
                description: {
                    en: 'Master power switch — turns entire cinema on/off',
                    de: 'Master-Schalter — schaltet gesamtes Kino ein/aus',
                },
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
            },
            {
                id: 'volume',
                name: { en: 'Volume', de: 'Lautstärke' },
                description: {
                    en: 'Amplifier volume (forwarded to the mapped amplifier datapoint)',
                    de: 'Verstärker-Lautstärke (wird an den zugeordneten Verstärker-Datenpunkt weitergeleitet)',
                },
                type: 'number',
                role: 'level.volume',
                unit: '%',
                min: 0,
                max: 100,
                read: true,
                write: true,
            },
            {
                id: 'mute',
                name: { en: 'Mute', de: 'Stumm' },
                description: {
                    en: 'Mute the amplifier',
                    de: 'Verstärker stummschalten',
                },
                type: 'boolean',
                role: 'media.mute',
                read: true,
                write: true,
            },
            {
                id: 'screen',
                name: { en: 'Screen', de: 'Leinwand' },
                description: {
                    en: 'Motorised screen control (true = down, false = up)',
                    de: 'Motorleinwand-Steuerung (true = runter, false = hoch)',
                },
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
            },
            {
                id: 'state',
                name: { en: 'State', de: 'Status' },
                description: {
                    en: 'Current state of the cinema (off, starting, on, stopping, error)',
                    de: 'Aktueller Status des Kinos (off, starting, on, stopping, error)',
                },
                type: 'string',
                role: 'media.state',
                read: true,
                write: false,
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
        rt.state = 'off';

        // Initialise output states
        await ctx.setOutputState('power', false, true);
        await ctx.setOutputState('state', 'off', true);
        await ctx.setOutputState('screen', false, true);
        await ctx.setOutputState('mute', false, true);

        // Read current volume from amplifier if available
        const ampVolState = await ctx.getInputState('amplifierVolume');
        if (ampVolState?.val !== null && ampVolState?.val !== undefined) {
            await ctx.setOutputState('volume', Number(ampVolState.val), true);
        } else {
            await ctx.setOutputState('volume', Number(ctx.config.volumeDefault ?? 30), true);
        }

        // Read mute state if available
        const muteState = await ctx.getInputState('amplifierMute');
        if (muteState?.val !== null && muteState?.val !== undefined) {
            await ctx.setOutputState('mute', Boolean(muteState.val), true);
        }

        ctx.log.info(`Home cinema "${ctx.deviceId}" initialised`);
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
            case 'amplifierVolume':
                // Sync volume feedback → virtual device
                await ctx.setOutputState('volume', Number(state.val), true);
                break;

            case 'amplifierMute':
                await ctx.setOutputState('mute', Boolean(state.val), true);
                break;

            case 'amplifierPower':
            case 'displayPower':
                // Could be used for state verification; log for now
                ctx.log.debug(`${inputId} changed to ${state.val}`);
                break;

            case 'screenPosition':
                ctx.log.debug(`Screen position changed to ${state.val}`);
                break;

            case 'sourceVolume':
                ctx.log.debug(`Source volume changed to ${state.val}`);
                break;

            case 'triggerPowerOn':
                if (state.val === true || state.val === 1) {
                    ctx.log.info('triggerPowerOn fired — powering on cinema');
                    await this._handlePower(ctx, true);
                }
                break;

            case 'triggerPowerOff':
                if (state.val === true || state.val === 1) {
                    ctx.log.info('triggerPowerOff fired — powering off cinema');
                    await this._handlePower(ctx, false);
                }
                break;
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {string} outputId
     * @param {any} value
     * @returns {Promise<void>}
     */
    async onOutputWrite(ctx, outputId, value) {
        const rt = getRuntime(ctx.deviceId);

        switch (outputId) {
            case 'power':
                await this._handlePower(ctx, Boolean(value));
                break;

            case 'volume':
                await this._handleVolume(ctx, Number(value));
                break;

            case 'mute':
                await this._handleMute(ctx, Boolean(value));
                break;

            case 'screen':
                await this._handleScreen(ctx, Boolean(value));
                break;

            default:
                ctx.log.warn(`Unknown output write: ${outputId} = ${value}`);
        }
    }

    /**
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async onDestroy(ctx) {
        const rt = runtimeState.get(ctx.deviceId);
        if (rt) {
            if (rt.activeChainExecutor) {
                rt.activeChainExecutor.abort();
            }
            if (rt.startupTimer) {
                clearTimeout(rt.startupTimer);
            }
            if (rt.shutdownTimer) {
                clearTimeout(rt.shutdownTimer);
            }
        }
        runtimeState.delete(ctx.deviceId);
        ctx.log.info(`Home cinema "${ctx.deviceId}" destroyed`);
    }

    // ======================================================================
    // Power control (state machine)
    // ======================================================================

    /**
     * Handle power on/off requests via the state machine.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} turnOn
     */
    async _handlePower(ctx, turnOn) {
        const rt = getRuntime(ctx.deviceId);

        if (turnOn && rt.state === 'off') {
            await this._startPowerOn(ctx);
        } else if (!turnOn && rt.state === 'on') {
            await this._startPowerOff(ctx);
        } else if (!turnOn && rt.state === 'starting') {
            // Abort startup, go to shutdown
            ctx.log.info('Power off requested during startup — aborting and shutting down');
            if (rt.activeChainExecutor) {
                rt.activeChainExecutor.abort();
                rt.activeChainExecutor = null;
            }
            if (rt.startupTimer) {
                clearTimeout(rt.startupTimer);
                rt.startupTimer = null;
            }
            await this._startPowerOff(ctx);
        } else if (turnOn && rt.state === 'stopping') {
            ctx.log.info('Power on requested during shutdown — ignoring (wait for off first)');
        } else {
            ctx.log.debug(`Power ${turnOn ? 'on' : 'off'} ignored in state "${rt.state}"`);
        }
    }

    /**
     * Execute the powerOn chain.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     */
    async _startPowerOn(ctx) {
        const rt = getRuntime(ctx.deviceId);
        const timeoutSec = Number(ctx.config.startupTimeout ?? 60);

        rt.state = 'starting';
        await ctx.setOutputState('state', 'starting', true);
        ctx.log.info('Cinema powering on...');

        // Set source volume to minimum level if mapped
        if (ctx.inputs.sourceVolume) {
            const minVol = Number(ctx.config.sourceVolumeMin ?? 90);
            ctx.log.info(`Setting source volume to ${minVol}%`);
            const minVolCast = await castToObjectType(ctx.adapter, ctx.inputs.sourceVolume, minVol, ctx.log);
            await ctx.adapter.setForeignStateAsync(ctx.inputs.sourceVolume, minVolCast, false);
        }

        // Execute powerOn chain
        const chain = this._getChain(ctx, 'powerOn');
        if (chain.length > 0 && typeof ctx.executeChain === 'function') {
            // Timeout guard
            rt.startupTimer = setTimeout(async () => {
                rt.startupTimer = null;
                if (rt.state === 'starting') {
                    ctx.log.error(`Startup timeout after ${timeoutSec}s — setting error state`);
                    if (rt.activeChainExecutor) {
                        rt.activeChainExecutor.abort();
                        rt.activeChainExecutor = null;
                    }
                    rt.state = 'error';
                    await ctx.setOutputState('state', 'error', true);
                    await ctx.setOutputState('power', false, true);
                }
            }, timeoutSec * 1000);

            try {
                rt.activeChainExecutor = await ctx.executeChain(chain);
                // Wait for chain completion
                if (rt.activeChainExecutor._promise) {
                    await rt.activeChainExecutor._promise;
                }
            } catch (e) {
                if (e.message && e.message.includes('aborted')) {
                    ctx.log.debug('PowerOn chain was aborted');
                    return;
                }
                ctx.log.error(`PowerOn chain failed: ${e}`);
                rt.state = 'error';
                await ctx.setOutputState('state', 'error', true);
                await ctx.setOutputState('power', false, true);
                return;
            } finally {
                rt.activeChainExecutor = null;
                if (rt.startupTimer) {
                    clearTimeout(rt.startupTimer);
                    rt.startupTimer = null;
                }
            }
        }

        // Only transition to 'on' if we're still in 'starting' (not aborted)
        if (rt.state === 'starting') {
            rt.state = 'on';
            await ctx.setOutputState('state', 'on', true);
            await ctx.setOutputState('power', true, true);
            await ctx.setOutputState('screen', true, true);

            // Set default volume
            const defaultVol = Number(ctx.config.volumeDefault ?? 30);
            await this._handleVolume(ctx, defaultVol);

            ctx.log.info('Cinema is ON');
        }
    }

    /**
     * Execute the powerOff chain.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     */
    async _startPowerOff(ctx) {
        const rt = getRuntime(ctx.deviceId);
        const timeoutSec = Number(ctx.config.shutdownTimeout ?? 30);

        rt.state = 'stopping';
        await ctx.setOutputState('state', 'stopping', true);
        ctx.log.info('Cinema powering off...');

        // Execute powerOff chain
        const chain = this._getChain(ctx, 'powerOff');
        if (chain.length > 0 && typeof ctx.executeChain === 'function') {
            // Timeout guard
            rt.shutdownTimer = setTimeout(async () => {
                rt.shutdownTimer = null;
                if (rt.state === 'stopping') {
                    ctx.log.warn(`Shutdown timeout after ${timeoutSec}s — forcing off`);
                    if (rt.activeChainExecutor) {
                        rt.activeChainExecutor.abort();
                        rt.activeChainExecutor = null;
                    }
                    rt.state = 'off';
                    await ctx.setOutputState('state', 'off', true);
                    await ctx.setOutputState('power', false, true);
                    await ctx.setOutputState('screen', false, true);
                }
            }, timeoutSec * 1000);

            try {
                rt.activeChainExecutor = await ctx.executeChain(chain);
                if (rt.activeChainExecutor._promise) {
                    await rt.activeChainExecutor._promise;
                }
            } catch (e) {
                if (e.message && e.message.includes('aborted')) {
                    ctx.log.debug('PowerOff chain was aborted');
                    return;
                }
                ctx.log.error(`PowerOff chain failed: ${e}`);
                // Force off even on error
            } finally {
                rt.activeChainExecutor = null;
                if (rt.shutdownTimer) {
                    clearTimeout(rt.shutdownTimer);
                    rt.shutdownTimer = null;
                }
            }
        }

        if (rt.state === 'stopping') {
            rt.state = 'off';
            await ctx.setOutputState('state', 'off', true);
            await ctx.setOutputState('power', false, true);
            await ctx.setOutputState('screen', false, true);
            await ctx.setOutputState('mute', false, true);
            ctx.log.info('Cinema is OFF');
        }
    }

    // ======================================================================
    // Volume / Mute
    // ======================================================================

    /**
     * Forward volume changes to the amplifier.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {number} volume
     */
    async _handleVolume(ctx, volume) {
        const clamped = Math.max(0, Math.min(100, volume));
        await ctx.setOutputState('volume', clamped, true);

        if (ctx.inputs.amplifierVolume) {
            const volCast = await castToObjectType(ctx.adapter, ctx.inputs.amplifierVolume, clamped, ctx.log);
            await ctx.adapter.setForeignStateAsync(ctx.inputs.amplifierVolume, volCast, false);
            ctx.log.debug(`Volume set to ${clamped}%`);
        }
    }

    /**
     * Forward mute changes to the amplifier.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} muted
     */
    async _handleMute(ctx, muted) {
        await ctx.setOutputState('mute', muted, true);

        if (ctx.inputs.amplifierMute) {
            const muteCast = await castToObjectType(ctx.adapter, ctx.inputs.amplifierMute, muted, ctx.log);
            await ctx.adapter.setForeignStateAsync(ctx.inputs.amplifierMute, muteCast, false);
            ctx.log.debug(`Mute set to ${muted}`);
        }
    }

    // ======================================================================
    // Screen control
    // ======================================================================

    /**
     * Control the motorised screen independently.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {boolean} down - true = screen down (visible), false = screen up (hidden)
     */
    async _handleScreen(ctx, down) {
        const rt = getRuntime(ctx.deviceId);
        const chainId = down ? 'screenDown' : 'screenUp';
        const chain = this._getChain(ctx, chainId);

        if (chain.length > 0 && typeof ctx.executeChain === 'function') {
            try {
                const executor = await ctx.executeChain(chain);
                if (executor._promise) {
                    await executor._promise;
                }
            } catch (e) {
                if (!(e.message && e.message.includes('aborted'))) {
                    ctx.log.error(`Screen ${chainId} chain failed: ${e}`);
                }
                return;
            }
        } else if (ctx.inputs.screenPosition) {
            // Fallback: direct write using config values
            const value = parseConfigValue(down ? (ctx.config.screenDownValue ?? '0') : (ctx.config.screenUpValue ?? '100'));
            const valueCast = await castToObjectType(ctx.adapter, ctx.inputs.screenPosition, value, ctx.log);
            await ctx.adapter.setForeignStateAsync(ctx.inputs.screenPosition, valueCast, false);
        }

        await ctx.setOutputState('screen', down, true);
        ctx.log.info(`Screen ${down ? 'down' : 'up'}`);
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    /**
     * Get a configured action chain by slot id, or an empty array.
     *
     * @param {import('../lib/plugin-interface').PluginContext} ctx
     * @param {string} slotId
     * @returns {import('../lib/plugin-interface').ActionChain}
     */
    _getChain(ctx, slotId) {
        if (ctx.chains && ctx.chains[slotId] && ctx.chains[slotId].length > 0) {
            return ctx.chains[slotId];
        }
        return [];
    }
}

module.exports = { HomeCinemaPlugin };

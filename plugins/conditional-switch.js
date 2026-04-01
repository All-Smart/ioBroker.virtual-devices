'use strict';

/**
 * Conditional Switch plugin.
 *
 * Generic rule-based switch controller. Evaluates a dynamic list of conditions
 * on arbitrary datapoints. All conditions must be met (AND) to activate the
 * output switches. An optional modifier input can change condition thresholds
 * dynamically (e.g., higher temperature when TV is running).
 *
 * Conditions are stored as a table (array) in config — the user can add/remove
 * as many as needed.
 *
 * @module conditional-switch
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a config value to match the type of the actual state value.
 */
function parseValue(stateVal, configVal) {
    if (typeof stateVal === 'boolean') {
        return configVal === 'true' || configVal === '1' || configVal === 'on';
    }
    if (typeof stateVal === 'number') {
        return Number(configVal);
    }
    return String(configVal);
}

/**
 * Evaluate a single condition.
 */
function evaluate(actual, operator, target) {
    switch (operator) {
        case '>':  return actual > target;
        case '<':  return actual < target;
        case '>=': return actual >= target;
        case '<=': return actual <= target;
        case '==': return actual == target; // eslint-disable-line eqeqeq
        case '!=': return actual != target; // eslint-disable-line eqeqeq
        default:   return false;
    }
}

// ---------------------------------------------------------------------------
// Operator options
// ---------------------------------------------------------------------------

const OPERATOR_OPTIONS = [
    { label: '> (greater)',    value: '>' },
    { label: '< (less)',       value: '<' },
    { label: '>= (greater/eq)', value: '>=' },
    { label: '<= (less/eq)',   value: '<=' },
    { label: '== (equals)',    value: '==' },
    { label: '!= (not eq)',    value: '!=' },
];

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class ConditionalSwitchPlugin {
    constructor() {
        this.id = 'conditional-switch';

        this.name = {
            en: 'Conditional Switch',
            de: 'Bedingter Schalter',
        };

        this.description = {
            en: 'Rule-based switch with flexible conditions and optional modifier',
            de: 'Regelbasierter Schalter mit flexiblen Bedingungen und optionalem Modifier',
        };

        /** @type {string} */
        this.icon = 'icons/conditional-switch.svg';

        // -- Input slots (only switches + modifier — conditions are dynamic) ---

        this.inputSlots = [
            {
                id: 'switch1',
                name: { en: 'Switch 1 (primary)', de: 'Schalter 1 (primär)' },
                description: { en: 'Primary output switch', de: 'Primärer Ausgangsschalter' },
                required: true,
                filter: { type: 'state', common: { type: 'boolean' } },
            },
            {
                id: 'switch2',
                name: { en: 'Switch 2 (secondary)', de: 'Schalter 2 (sekundär)' },
                description: { en: 'Optional secondary switch', de: 'Optionaler zweiter Schalter' },
                required: false,
                filter: { type: 'state', common: { type: 'boolean' } },
            },
            {
                id: 'modifier',
                name: { en: 'Modifier input', de: 'Modifier Eingang' },
                description: {
                    en: 'When active, conditions use their alternative values',
                    de: 'Wenn aktiv, nutzen Bedingungen ihre Alternativwerte',
                },
                required: false,
                filter: { type: 'state' },
            },
        ];

        // -- Config schema -----------------------------------------------------

        this.configSchema = {
            conditions: {
                type: 'table',
                label: { en: 'Conditions (all must be true)', de: 'Bedingungen (alle müssen erfüllt sein)' },
                items: [
                    {
                        type: 'text',
                        title: { en: 'Object ID', de: 'Objekt-ID' },
                        attr: 'objectId',
                        filter: true,
                        sort: true,
                        default: '',
                    },
                    {
                        type: 'select',
                        title: { en: 'Operator', de: 'Operator' },
                        attr: 'operator',
                        options: OPERATOR_OPTIONS,
                        default: '>',
                    },
                    {
                        type: 'text',
                        title: { en: 'Value', de: 'Wert' },
                        attr: 'value',
                        default: '',
                    },
                    {
                        type: 'text',
                        title: { en: 'Alt. value (modifier)', de: 'Alt. Wert (Modifier)' },
                        attr: 'altValue',
                        default: '',
                    },
                ],
                sm: 12,
                newLine: true,
            },

            modifier_operator: {
                type: 'select',
                label: { en: 'Modifier operator', de: 'Modifier Operator' },
                options: OPERATOR_OPTIONS,
                sm: 6, newLine: true,
            },
            modifier_value: {
                type: 'text',
                label: { en: 'Modifier trigger value', de: 'Modifier Auslösewert' },
                help: {
                    en: 'When modifier input matches → alternative values in table are used',
                    de: 'Wenn Modifier-Eingang zutrifft → Alternativwerte in der Tabelle werden benutzt',
                },
                sm: 6,
            },
        };

        this.configDefaults = {
            conditions: [],
            modifier_operator: '==',
            modifier_value: '',
        };

        // -- Output states -----------------------------------------------------

        this.outputStates = [
            {
                id: 'active',
                name: { en: 'Active', de: 'Aktiv' },
                description: { en: 'All conditions met, switches are on', de: 'Alle Bedingungen erfüllt, Schalter sind ein' },
                type: 'boolean',
                role: 'indicator.working',
                read: true, write: false,
            },
            {
                id: 'modifierActive',
                name: { en: 'Modifier active', de: 'Modifier aktiv' },
                type: 'boolean',
                role: 'indicator',
                read: true, write: false,
            },
            {
                id: 'enabled',
                name: { en: 'Automatic control', de: 'Automatische Steuerung' },
                description: { en: 'Enable/disable automatic switch control', de: 'Automatische Schaltersteuerung ein-/ausschalten' },
                type: 'boolean',
                role: 'switch.enable',
                read: true, write: true,
            },
        ];
    }

    // ======================================================================
    // Lifecycle
    // ======================================================================

    async onInit(ctx) {
        await ctx.setOutputState('active', false, true);
        await ctx.setOutputState('modifierActive', false, true);

        const enabledState = await ctx.getOutputState('enabled');
        if (enabledState === null || enabledState.val === null) {
            await ctx.setOutputState('enabled', true, true);
        }

        await this._evaluate(ctx);
        ctx.log.info(`Conditional switch "${ctx.deviceId}" initialised`);
    }

    async onInputChange(ctx, inputId, state) {
        if (!state) return;
        // Any input change (modifier, switch feedback, or dynamic condition) → re-evaluate
        await this._evaluate(ctx);
    }

    async onDestroy(ctx) {
        ctx.log.info(`Conditional switch "${ctx.deviceId}" destroyed`);
    }

    /**
     * Return objectIds from the conditions table that need foreign state subscriptions.
     * Called by the main adapter during _startDevice.
     *
     * @param {Record<string, any>} config - device config
     * @returns {Array<{ id: string, objectId: string }>}
     */
    getDynamicSubscriptions(config) {
        const subs = [];
        const conditions = config.conditions;
        if (Array.isArray(conditions)) {
            for (let i = 0; i < conditions.length; i++) {
                const c = conditions[i];
                if (c.objectId) {
                    subs.push({ id: `_cond_${i}`, objectId: c.objectId });
                }
            }
        }
        return subs;
    }

    // ======================================================================
    // Core evaluation
    // ======================================================================

    async _evaluate(ctx) {
        const enabled = await ctx.getOutputState('enabled');
        if (!enabled || enabled.val !== true) {
            await this._setSwitches(ctx, false);
            await ctx.setOutputState('active', false, true);
            return;
        }

        // 1. Check modifier
        let modifierActive = false;
        if (ctx.inputs.modifier) {
            const modState = await ctx.getInputState('modifier');
            if (modState?.val !== null && modState?.val !== undefined) {
                const modOp = ctx.config.modifier_operator || '==';
                const modTarget = parseValue(modState.val, ctx.config.modifier_value || '');
                modifierActive = evaluate(modState.val, modOp, modTarget);
            }
        }
        await ctx.setOutputState('modifierActive', modifierActive, true);

        // 2. Evaluate conditions from table
        const conditions = ctx.config.conditions;
        if (!Array.isArray(conditions) || conditions.length === 0) {
            await this._setSwitches(ctx, false);
            await ctx.setOutputState('active', false, true);
            return;
        }

        let allMet = true;
        for (let i = 0; i < conditions.length; i++) {
            const cond = conditions[i];
            if (!cond.objectId || !cond.operator || (cond.value === '' && cond.value === undefined)) {
                continue; // skip incomplete rows
            }

            // Read state via dynamic subscription input id
            const inputId = `_cond_${i}`;
            const state = await ctx.getInputState(inputId);
            if (state?.val === null || state?.val === undefined) {
                allMet = false;
                continue;
            }

            const useAlt = modifierActive && cond.altValue !== '' && cond.altValue !== undefined;
            const targetStr = useAlt ? cond.altValue : cond.value;
            const target = parseValue(state.val, targetStr);

            if (!evaluate(state.val, cond.operator, target)) {
                allMet = false;
            }
        }

        const currentActive = await ctx.getOutputState('active');
        const wasActive = currentActive?.val === true;

        if (allMet && !wasActive) {
            ctx.log.info(`All conditions met → turning ON`);
            await this._setSwitches(ctx, true);
            await ctx.setOutputState('active', true, true);
        } else if (!allMet && wasActive) {
            ctx.log.info(`Condition(s) no longer met → turning OFF`);
            await this._setSwitches(ctx, false);
            await ctx.setOutputState('active', false, true);
        }
    }

    async _setSwitches(ctx, on) {
        if (ctx.inputs.switch1) {
            await ctx.adapter.setForeignStateAsync(ctx.inputs.switch1, on, false);
        }
        if (ctx.inputs.switch2) {
            await ctx.adapter.setForeignStateAsync(ctx.inputs.switch2, on, false);
        }
    }
}

module.exports = { ConditionalSwitchPlugin };

'use strict';

/**
 * ioBroker.virtual-devices — main adapter entry point.
 *
 * This adapter lets users create virtual devices that combine existing ioBroker
 * datapoints with plugin-based logic.  The entire admin UI is driven by the
 * device-manager integration (`@iobroker/dm-utils`).
 *
 * ### Lifecycle
 *
 * 1. `onReady`  — load plugins, read all persisted device configs, create
 *    output states, initialise plugins, subscribe to inputs.
 * 2. `onStateChange` — route changes to the correct device plugin.
 * 3. `onMessage` — handle internal messages from the device-management layer
 *    (deviceAdded / deviceUpdated / deviceDeleted).
 * 4. `onUnload` — destroy all running devices.
 *
 * @module main
 */

const path = require('path');
const fs = require('fs');
const utils = require('@iobroker/adapter-core');

const VirtualDevicesManagement = require('./device-management');
const { loadBuiltInPlugins, getPlugin } = require('./plugin-registry');
const { ActionChainExecutor } = require('./action-chain');

// ---------------------------------------------------------------------------
// Icon helper (mirrors device-management.js)
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin icon to a base64 data-URI, reading from admin/ if needed.
 * @param {string|undefined} iconPath
 * @returns {string|undefined}
 */
function resolveIconDataUri(iconPath) {
    if (!iconPath) return undefined;
    if (iconPath.startsWith('data:') || iconPath.startsWith('http')) return iconPath;
    try {
        const adminDir = path.join(__dirname, '..', 'admin');
        const fullPath = path.join(adminDir, iconPath);
        const content = fs.readFileSync(fullPath);
        return 'data:image/svg+xml;base64,' + content.toString('base64');
    } catch {
        return iconPath;
    }
}

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DeviceInstance
 * @property {string}                            deviceId        - Unique device identifier.
 * @property {import('./plugin-interface').VirtualDevicePlugin} plugin - The plugin instance.
 * @property {import('./plugin-interface').PluginContext}        ctx    - Runtime context.
 * @property {Record<string,string>}             inputMap        - inputSlotId → objectId.
 * @property {Map<string,string>}                reverseInputMap - objectId → inputSlotId.
 * @property {Set<ActionChainExecutor>}          activeChains    - Currently running chain executors.
 */

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

class VirtualDevicesAdapter extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options = {}) {
        super({
            ...options,
            name: 'virtual-devices',
        });

        /** @type {VirtualDevicesManagement} */
        this.deviceManagement = null;

        /** @type {Map<string, DeviceInstance>} */
        this.devices = new Map();

        /** @type {Map<string, DeviceInstance[]>} */
        this.stateSubscribers = new Map();

        this.on('ready', this._onReady.bind(this));
        this.on('stateChange', this._onStateChange.bind(this));
        this.on('message', this._onMessage.bind(this));
        this.on('unload', this._onUnload.bind(this));
    }

    // ======================================================================
    // Lifecycle
    // ======================================================================

    /** @returns {Promise<void>} */
    async _onReady() {
        this.log.info('Starting virtual-devices adapter…');

        // Initialise device-management integration
        this.deviceManagement = new VirtualDevicesManagement(this);

        // Load plugin registry
        await loadBuiltInPlugins();
        this.log.info('Built-in plugins loaded');

        // Subscribe to own namespace for writable output states (e.g. enabled switch)
        await this.subscribeStatesAsync('*');

        // Read persisted device configurations and start them
        await this._startAllDevices();

        this.log.info(`Adapter ready — ${this.devices.size} device(s) running`);
    }

    /**
     * @param {() => void} callback
     * @returns {Promise<void>}
     */
    async _onUnload(callback) {
        try {
            for (const instance of this.devices.values()) {
                try {
                    await instance.plugin.onDestroy(instance.ctx);
                } catch (e) {
                    this.log.error(`Error destroying device "${instance.deviceId}": ${e}`);
                }
            }
            this.devices.clear();
            this.stateSubscribers.clear();
        } catch {
            // ignore
        } finally {
            callback();
        }
    }

    // ======================================================================
    // State change routing
    // ======================================================================

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     * @returns {Promise<void>}
     */
    async _onStateChange(id, state) {
        if (!state) return;

        // 1. Check if this is a writable output state change (user toggling a control)
        //    Pattern: virtual-devices.0.{deviceId}.{stateId}
        if (id.startsWith(this.namespace + '.') && !state.ack) {
            await this._handleOutputStateChange(id, state);
        }

        // 2. Route state changes to active chain executors
        for (const instance of this.devices.values()) {
            for (const executor of instance.activeChains) {
                executor.onStateChange(id, state);
            }
        }

        // 3. Route foreign state changes to subscribed device plugins
        const fullId = id;
        const subscribers = this.stateSubscribers.get(fullId);
        if (subscribers) {
            for (const instance of subscribers) {
                const inputId = instance.reverseInputMap.get(fullId);
                if (inputId) {
                    try {
                        await instance.plugin.onInputChange(instance.ctx, inputId, state);
                    } catch (e) {
                        this.log.error(`Plugin error on input change (device=${instance.deviceId}, input=${inputId}): ${e}`);
                    }
                }
            }
        }
    }

    /**
     * Handle writes to output states (e.g., user toggling `enabled`).
     * This is for states within our own namespace written without ack.
     *
     * @param {string} id
     * @param {ioBroker.State} state
     * @returns {Promise<void>}
     */
    async _handleOutputStateChange(id, state) {
        // Parse: virtual-devices.0.{deviceId}.{stateId}
        const parts = id.replace(this.namespace + '.', '').split('.');
        if (parts.length < 2) return;

        const deviceId = parts[0];
        const stateId = parts[1];
        const instance = this.devices.get(deviceId);
        if (!instance) return;

        const outputDef = instance.plugin.outputStates.find((o) => o.id === stateId);
        if (!outputDef?.write) return;

        // Acknowledge the state
        await this.setStateAsync(id, state.val, true);

        // Special handling per plugin logic
        // For the dehumidifier: when enabled is set to true, reset tankFull
        if (stateId === 'enabled' && state.val === true) {
            const tankFullState = await this.getStateAsync(`${this.namespace}.${deviceId}.tankFull`);
            if (tankFullState?.val === true) {
                await this.setStateAsync(`${this.namespace}.${deviceId}.tankFull`, false, true);
                this.log.info(`Device "${deviceId}": tank-full alarm reset by re-enabling`);
            }
        }
    }

    // ======================================================================
    // Internal messages
    // ======================================================================

    /**
     * @param {ioBroker.Message} msg
     * @returns {Promise<void>}
     */
    async _onMessage(msg) {
        if (!msg?.command) return;

        // dm-utils handles all dm:* messages — do NOT intercept them
        if (msg.command.startsWith('dm:')) return;

        switch (msg.command) {
            case 'deviceAdded': {
                const { deviceId } = msg.message;
                this.log.info(`Device added: ${deviceId}`);
                await this._startDevice(deviceId);
                break;
            }
            case 'deviceUpdated': {
                const { deviceId } = msg.message;
                this.log.info(`Device updated: ${deviceId}`);
                await this._stopDevice(deviceId);
                await this._startDevice(deviceId);
                break;
            }
            case 'deviceDeleted': {
                const { deviceId } = msg.message;
                this.log.info(`Device deleted: ${deviceId}`);
                await this._stopDevice(deviceId);
                break;
            }
            default:
                // dm-utils handles its own messages; we only care about ours
                break;
        }

        // Always respond to prevent timeouts
        if (msg.callback) {
            this.sendTo(msg.from, msg.command, { result: 'ok' }, msg.callback);
        }
    }

    // ======================================================================
    // Device start / stop
    // ======================================================================

    /**
     * Read all persisted device configs and start each one.
     *
     * @returns {Promise<void>}
     */
    async _startAllDevices() {
        const objs = await this.getObjectViewAsync('system', 'device', {
            startkey: `${this.namespace}.`,
            endkey: `${this.namespace}.\u9999`,
        });

        if (!objs?.rows) return;

        for (const row of objs.rows) {
            const deviceId = row.id.replace(`${this.namespace}.`, '');
            try {
                await this._startDevice(deviceId);
            } catch (e) {
                this.log.error(`Failed to start device "${deviceId}": ${e}`);
            }
        }
    }

    /**
     * Start (or restart) a single virtual device.
     *
     * @param {string} deviceId
     * @returns {Promise<void>}
     */
    async _startDevice(deviceId) {
        // Read stored config
        const obj = await this.getObjectAsync(deviceId);
        if (!obj) {
            this.log.warn(`Device config not found: ${deviceId}`);
            return;
        }

        /** @type {import('./plugin-interface').StoredDeviceConfig} */
        const native = obj.native;
        if (!native?.pluginId) {
            this.log.warn(`Device "${deviceId}" has no pluginId`);
            return;
        }

        const plugin = getPlugin(native.pluginId);
        if (!plugin) {
            this.log.error(`Plugin "${native.pluginId}" not found for device "${deviceId}"`);
            return;
        }

        // Backfill common.icon if missing (for devices created before icon support was added)
        if (!obj.common?.icon && plugin.icon) {
            const iconDataUri = resolveIconDataUri(plugin.icon);
            if (iconDataUri) {
                await this.extendObjectAsync(deviceId, { common: { icon: iconDataUri } });
            }
        }

        // Ensure output state objects exist
        await this._ensureOutputStates(deviceId, plugin);

        // Build plugin context
        const ctx = this._buildContext(deviceId, native, plugin);

        // Build input maps
        const reverseInputMap = new Map();
        for (const [slotId, objectId] of Object.entries(native.inputs)) {
            if (objectId) {
                reverseInputMap.set(objectId, slotId);
            }
        }

        /** @type {DeviceInstance} */
        const instance = {
            deviceId,
            plugin,
            ctx,
            inputMap: native.inputs,
            reverseInputMap,
            activeChains: new Set(),
        };

        this.devices.set(deviceId, instance);

        // Subscribe to all mapped foreign input states
        for (const objectId of Object.values(native.inputs)) {
            if (!objectId) continue;
            await this.subscribeForeignStatesAsync(objectId);

            const existing = this.stateSubscribers.get(objectId) || [];
            existing.push(instance);
            this.stateSubscribers.set(objectId, existing);
        }

        // Subscribe to dynamic condition inputs (e.g. from conditions table)
        if (typeof plugin.getDynamicSubscriptions === 'function') {
            const dynSubs = plugin.getDynamicSubscriptions(native.config || {});
            for (const sub of dynSubs) {
                if (!sub.objectId) continue;
                reverseInputMap.set(sub.objectId, sub.id);

                await this.subscribeForeignStatesAsync(sub.objectId);
                const existing = this.stateSubscribers.get(sub.objectId) || [];
                existing.push(instance);
                this.stateSubscribers.set(sub.objectId, existing);
            }
        }

        // Initialise the plugin
        try {
            await plugin.onInit(ctx);
        } catch (e) {
            this.log.error(`Plugin init failed for device "${deviceId}": ${e}`);
        }
    }

    /**
     * Stop a running device, calling its onDestroy and cleaning up subscriptions.
     *
     * @param {string} deviceId
     * @returns {Promise<void>}
     */
    async _stopDevice(deviceId) {
        const instance = this.devices.get(deviceId);
        if (!instance) return;

        // Abort all active chain executions
        for (const executor of instance.activeChains) {
            executor.abort();
        }
        instance.activeChains.clear();

        try {
            await instance.plugin.onDestroy(instance.ctx);
        } catch (e) {
            this.log.error(`Plugin destroy failed for device "${deviceId}": ${e}`);
        }

        // Remove from subscriber index
        for (const objectId of Object.values(instance.inputMap)) {
            if (!objectId) continue;
            const subs = this.stateSubscribers.get(objectId);
            if (subs) {
                const filtered = subs.filter((s) => s.deviceId !== deviceId);
                if (filtered.length === 0) {
                    this.stateSubscribers.delete(objectId);
                    await this.unsubscribeForeignStatesAsync(objectId);
                } else {
                    this.stateSubscribers.set(objectId, filtered);
                }
            }
        }

        this.devices.delete(deviceId);
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    /**
     * Create ioBroker state objects for all output states defined by the plugin.
     *
     * @param {string} deviceId
     * @param {import('./plugin-interface').VirtualDevicePlugin} plugin
     * @returns {Promise<void>}
     */
    async _ensureOutputStates(deviceId, plugin) {
        // Device object is already created by device-management with config in native.
        // Only ensure it exists as a fallback (should not normally be needed).

        for (const out of plugin.outputStates) {
            const stateObjId = `${deviceId}.${out.id}`;
            /** @type {object} */
            const common = {
                name: out.name,
                type: out.type,
                role: out.role,
                read: out.read,
                write: out.write,
            };
            if (out.unit !== undefined) common.unit = out.unit;
            if (out.min !== undefined) common.min = out.min;
            if (out.max !== undefined) common.max = out.max;

            await this.setObjectNotExistsAsync(stateObjId, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    /**
     * Build a PluginContext for a device.
     *
     * @param {string} deviceId
     * @param {import('./plugin-interface').StoredDeviceConfig} native
     * @param {import('./plugin-interface').VirtualDevicePlugin} plugin
     * @returns {import('./plugin-interface').PluginContext}
     */
    _buildContext(deviceId, native, plugin) {
        const adapter = this;
        /** @type {Record<string, any>} */
        const mergedConfig = {
            ...plugin.configDefaults,
            ...native.config,
        };

        // Build a lookup for dynamic inputs (populated after context creation)
        /** @type {Record<string, string>} */
        const dynamicInputs = {};

        // Add dynamic subscriptions from plugin (conditions table etc.)
        if (typeof plugin.getDynamicSubscriptions === 'function') {
            const dynSubs = plugin.getDynamicSubscriptions(native.config || {});
            for (const sub of dynSubs) {
                if (sub.objectId) {
                    dynamicInputs[sub.id] = sub.objectId;
                }
            }
        }

        return {
            deviceId,
            config: mergedConfig,
            inputs: native.inputs,
            chains: native.chains || {},

            async getInputState(inputId) {
                // Check static inputs first, then dynamic
                const objectId = native.inputs[inputId] || dynamicInputs[inputId];
                if (!objectId) return null;
                const state = await adapter.getForeignStateAsync(objectId);
                return state ?? null;
            },

            async setOutputState(outputId, value, ack = true) {
                await adapter.setStateAsync(`${deviceId}.${outputId}`, value, ack);
            },

            async getOutputState(outputId) {
                const state = await adapter.getStateAsync(`${deviceId}.${outputId}`);
                return state ?? null;
            },

            async executeChain(chain) {
                const executor = new ActionChainExecutor();
                // Find the device instance to track active chains
                const inst = adapter.devices.get(deviceId);
                if (inst) {
                    inst.activeChains.add(executor);
                }

                // Subscribe to states referenced in chain wait conditions
                const stateWaitIds = new Set();
                for (const step of chain) {
                    if (step.waitBefore?.type === 'state' && step.waitBefore.objectId) {
                        stateWaitIds.add(step.waitBefore.objectId);
                    }
                }
                for (const oid of stateWaitIds) {
                    await adapter.subscribeForeignStatesAsync(oid);
                }

                try {
                    await executor.execute(/** @type {any} */ (adapter), chain, adapter.log);
                } finally {
                    if (inst) {
                        inst.activeChains.delete(executor);
                    }
                }

                return executor;
            },

            log: adapter.log,
            adapter: /** @type {any} */ (adapter),
        };
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (require.main !== module) {
    // Export the constructor for ioBroker
    module.exports = (options) => new VirtualDevicesAdapter(options);
} else {
    // Stand-alone start
    (() => new VirtualDevicesAdapter())();
}

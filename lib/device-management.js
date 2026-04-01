'use strict';

/**
 * Device management integration via `@iobroker/dm-utils`.
 *
 * This module extends the dm-utils `DeviceManagement` base class and wires
 * every admin UI interaction (add / edit / delete / details / controls)
 * through to the plugin system.  No custom React — everything is driven by
 * JSONConfig forms and the standard device-manager UI in ioBroker admin.
 *
 * @module device-management
 */

const path = require('path');
const fs = require('fs');
const { DeviceManagement, ACTIONS } = require('@iobroker/dm-utils');
const { getAllPlugins, getPlugin } = require('./plugin-registry');

// ---------------------------------------------------------------------------
// Icon helper
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin icon path to a base64 data-URI.
 * If the icon is already a data-URI or HTTP URL, return as-is.
 * Otherwise read from admin/ directory and encode as base64.
 *
 * @param {string|undefined} iconPath - Path relative to admin/ or data-URI.
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
        // Fall back to relative path if file can't be read
        return iconPath;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an i18n StringOrTranslated to a plain string (English fallback).
 *
 * @param {string | Record<string,string>} s
 * @returns {string}
 */
function t(s) {
    if (typeof s === 'string') return s;
    return s.en ?? Object.values(s)[0] ?? '';
}

/**
 * Build a JSONConfig `objectID` item from an InputSlot definition.
 * The resulting picker will pre-filter objects based on the slot's filter.
 *
 * @param {import('./plugin-interface').InputSlot} slot
 * @returns {import('./plugin-interface').JsonConfigItem}
 */
function buildObjectIdPicker(slot) {
    const item = {
        type: 'objectId',
        label: slot.name,
        help: slot.description,
    };

    // Build customFilter for the objectId picker.
    // Docs: {common: {type: 'number', role: ['switch', 'button']}}
    // Role uses prefix matching: 'switch' matches 'switch', 'switch.power', etc.
    // Do NOT set top-level type here — the picker defaults to states already.
    if (slot.filter.common) {
        /** @type {Record<string, any>} */
        const common = {};

        if (slot.filter.common.type) {
            common.type = slot.filter.common.type;
        }
        if (slot.filter.common.role) {
            common.role = Array.isArray(slot.filter.common.role)
                ? slot.filter.common.role
                : [slot.filter.common.role];
        }
        if (slot.filter.common.unit) {
            common.unit = slot.filter.common.unit;
        }

        if (Object.keys(common).length > 0) {
            item.customFilter = { common };
        }
    }

    return item;
}

/**
 * Merge a plugin's input-slot pickers and config schema into a single
 * JSONConfig schema suitable for `context.showForm()`.
 *
 * @param {import('./plugin-interface').VirtualDevicePlugin} plugin
 * @param {Record<string, any>} [existingValues]
 * @returns {{ schema: object, data: Record<string, any> }}
 */
function buildDeviceForm(plugin, existingValues) {
    /** @type {Record<string, any>} */
    const items = {};
    /** @type {Record<string, any>} */
    const data = existingValues ? { ...existingValues } : {};

    // -- Header: Input Datapoints -------------------------------------------
    items._inputHeader = {
        type: 'header',
        text: { en: 'Input Datapoints', de: 'Eingangs-Datenpunkte' },
        size: 4,
    };

    for (const slot of plugin.inputSlots) {
        const key = `input_${slot.id}`;
        items[key] = buildObjectIdPicker(slot);
        if (!data[key]) {
            data[key] = '';
        }
    }

    // -- Header: Device Settings --------------------------------------------
    if (Object.keys(plugin.configSchema).length > 0) {
        items._configHeader = {
            type: 'header',
            text: { en: 'Device Settings', de: 'Geräteeinstellungen' },
            size: 4,
        };

        let scheduleHeaderAdded = false;
        for (const [key, schema] of Object.entries(plugin.configSchema)) {
            // Add a schedule header before the first schedule field
            if (key.startsWith('schedule') && !scheduleHeaderAdded) {
                items._scheduleHeader = {
                    type: 'header',
                    text: { en: 'Schedule (leave empty for 24/7)', de: 'Zeitplan (leer lassen für 24/7)' },
                    size: 5,
                };
                scheduleHeaderAdded = true;
            }
            const cfgKey = `cfg_${key}`;
            items[cfgKey] = { ...schema };
            if (data[cfgKey] === undefined) {
                data[cfgKey] = plugin.configDefaults[key];
            }
        }
    }

    // -- Header: Action Chains ------------------------------------------------
    if (plugin.actionChainSlots && Object.keys(plugin.actionChainSlots).length > 0) {
        items._chainHeader = {
            type: 'header',
            text: { en: 'Action Chains', de: 'Schalt-Ketten' },
            size: 4,
        };

        for (const [slotId, slot] of Object.entries(plugin.actionChainSlots)) {
            const chainKey = `chain_${slotId}`;

            items[`_chainLabel_${slotId}`] = {
                type: 'staticText',
                text: slot.name,
                style: { fontWeight: 'bold', marginTop: 8 },
                newLine: true,
            };

            if (slot.description) {
                items[`_chainDesc_${slotId}`] = {
                    type: 'staticText',
                    text: slot.description,
                    style: { fontSize: '0.85em', opacity: 0.7, marginBottom: 4 },
                };
            }

            items[chainKey] = {
                type: 'table',
                items: [
                    {
                        type: 'objectId',
                        attr: 'objectId',
                        title: { en: 'Object ID', de: 'Objekt ID' },
                        width: '30%',
                        filter: false,
                        sort: false,
                    },
                    {
                        type: 'text',
                        attr: 'value',
                        title: { en: 'Value', de: 'Wert' },
                        width: '15%',
                        filter: false,
                        sort: false,
                    },
                    {
                        type: 'select',
                        attr: 'waitType',
                        title: { en: 'Wait type', de: 'Wartetyp' },
                        width: '15%',
                        filter: false,
                        sort: false,
                        options: [
                            { label: { en: 'None', de: 'Keine' }, value: 'none' },
                            { label: { en: 'Delay (ms)', de: 'Wartezeit (ms)' }, value: 'delay' },
                            { label: { en: 'Wait for state', de: 'Auf Zustand warten' }, value: 'state' },
                        ],
                        default: 'none',
                    },
                    {
                        type: 'number',
                        attr: 'waitMs',
                        title: { en: 'Wait (ms)', de: 'Wartezeit (ms)' },
                        width: '15%',
                        filter: false,
                        sort: false,
                        default: 0,
                    },
                    {
                        type: 'text',
                        attr: 'waitValue',
                        title: { en: 'Wait for value', de: 'Warte auf Wert' },
                        width: '25%',
                        filter: false,
                        sort: false,
                    },
                ],
                noDelete: false,
            };

            if (!data[chainKey]) {
                data[chainKey] = [];
            }
        }
    }

    const formSchema = {
        type: 'panel',
        items,
    };

    return { schema: formSchema, data };
}

/**
 * Extract input mappings and config values from the flat form data returned
 * by `context.showForm()`.
 *
 * @param {import('./plugin-interface').VirtualDevicePlugin} plugin
 * @param {Record<string, any>} formData
 * @returns {{ inputs: Record<string, string>, config: Record<string, any> }}
 */
function parseFormData(plugin, formData) {
    /** @type {Record<string, string>} */
    const inputs = {};
    /** @type {Record<string, any>} */
    const config = {};

    for (const slot of plugin.inputSlots) {
        const v = formData[`input_${slot.id}`];
        if (v) {
            inputs[slot.id] = String(v);
        }
    }

    for (const key of Object.keys(plugin.configSchema)) {
        const v = formData[`cfg_${key}`];
        config[key] = v !== undefined ? v : plugin.configDefaults[key];
    }

    // Parse action chain data from table rows
    /** @type {Record<string, import('./plugin-interface').ActionChainStep[]>} */
    const chains = {};
    if (plugin.actionChainSlots) {
        for (const slotId of Object.keys(plugin.actionChainSlots)) {
            const rows = formData[`chain_${slotId}`];
            if (Array.isArray(rows) && rows.length > 0) {
                chains[slotId] = rows
                    .filter((row) => row.objectId) // Skip empty rows
                    .map((row) => {
                        /** @type {import('./plugin-interface').ActionChainStep} */
                        const step = {
                            objectId: String(row.objectId),
                            value: row.value,
                        };
                        if (row.waitType === 'delay' && row.waitMs > 0) {
                            step.waitBefore = { type: 'delay', ms: Number(row.waitMs) };
                        } else if (row.waitType === 'state' && row.waitValue !== undefined && row.waitValue !== '') {
                            step.waitBefore = {
                                type: 'state',
                                objectId: String(row.objectId),
                                value: row.waitValue,
                            };
                        }
                        return step;
                    });
            }
        }
    }

    return { inputs, config, chains };
}

// ---------------------------------------------------------------------------
// DeviceManagement implementation
// ---------------------------------------------------------------------------

class VirtualDevicesManagement extends DeviceManagement {

    // -- Instance info & actions -------------------------------------------

    /** @returns {object} */
    async getInstanceInfo() {
        return {
            ...super.getInstanceInfo(),
            apiVersion: 'v1',
            actions: [
                {
                    id: 'add-device',
                    icon: 'add',
                    title: { en: 'Add virtual device', de: 'Virtuelles Gerät hinzufügen' },
                    description: { en: 'Add virtual device', de: 'Virtuelles Gerät hinzufügen' },
                    handler: (context) => this.addDevice(context),
                },
            ],
        };
    }

    // -- List devices ------------------------------------------------------

    /** @returns {Promise<object[]>} */
    async listDevices() {
        /** @type {object[]} */
        const devices = [];

        const objs = await this.adapter.getObjectViewAsync('system', 'device', {
            startkey: `${this.adapter.namespace}.`,
            endkey: `${this.adapter.namespace}.\u9999`,
        });

        if (!objs?.rows) return devices;

        for (const row of objs.rows) {
            const obj = row.value;
            if (!obj) continue;

            /** @type {import('./plugin-interface').StoredDeviceConfig | undefined} */
            const native = obj.native;
            if (!native?.pluginId) continue;

            const plugin = getPlugin(native.pluginId);
            const deviceId = row.id.replace(`${this.adapter.namespace}.`, '');

            // Determine status: all required inputs mapped?
            let allMapped = true;
            if (plugin) {
                for (const slot of plugin.inputSlots) {
                    if (slot.required && !native.inputs?.[slot.id]) {
                        allMapped = false;
                        break;
                    }
                }
            }

            // Read enabled state for the device card icon
            let enabledVal = true;
            if (plugin) {
                const enabledOut = plugin.outputStates.find((o) => o.id === 'enabled');
                if (enabledOut) {
                    const enabledState = await this.adapter.getStateAsync(
                        `${this.adapter.namespace}.${deviceId}.enabled`
                    );
                    if (enabledState?.val !== null && enabledState?.val !== undefined) {
                        enabledVal = !!enabledState.val;
                    }
                }
            }

            devices.push({
                id: deviceId,
                name: native.deviceName || deviceId,
                status: allMapped ? 'connected' : 'disconnected',
                enabled: enabledVal,
                hasDetails: true,
                actions: [
                    {
                        id: ACTIONS.ENABLE_DISABLE,
                        icon: enabledVal ? 'pause' : 'play',
                        description: enabledVal
                            ? { en: 'Disable automatic control', de: 'Automatische Steuerung deaktivieren' }
                            : { en: 'Enable automatic control', de: 'Automatische Steuerung aktivieren' },
                        handler: (devId, context) =>
                            this.toggleEnabled(devId, context),
                    },
                    {
                        id: 'edit',
                        icon: 'edit',
                        description: { en: 'Edit device', de: 'Gerät bearbeiten' },
                        handler: (devId, context) =>
                            this.editDevice(devId, context),
                    },
                    {
                        id: 'delete',
                        icon: 'delete',
                        description: { en: 'Delete device', de: 'Gerät löschen' },
                        handler: (devId, context) =>
                            this.deleteDevice(devId, context),
                    },
                ],
            });
        }

        return devices;
    }

    // -- Device details (read-only current values) -------------------------

    /**
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async getDeviceDetails(id) {
        const obj = await this.adapter.getObjectAsync(id);
        if (!obj) return null;

        /** @type {import('./plugin-interface').StoredDeviceConfig} */
        const native = obj.native;
        const plugin = getPlugin(native.pluginId);
        if (!plugin) return null;

        /** @type {Record<string, any>} */
        const items = {
            _header: {
                type: 'header',
                text: { en: 'Current Values', de: 'Aktuelle Werte' },
                size: 4,
            },
        };

        /** @type {Record<string, any>} */
        const data = {};

        for (const out of plugin.outputStates) {
            const stateId = `${this.adapter.namespace}.${id}.${out.id}`;
            const state = await this.adapter.getStateAsync(stateId);

            let displayValue = state?.val ?? '—';
            if (out.type === 'boolean' && state?.val !== null && state?.val !== undefined) {
                displayValue = state.val ? '✅' : '❌';
            } else if (out.unit && state?.val !== null && state?.val !== undefined) {
                displayValue = `${state.val} ${out.unit}`;
            }

            const label = typeof out.name === 'object' ? out.name : { en: out.name, de: out.name };

            const key = `detail_${out.id}`;
            items[key] = {
                type: 'staticText',
                text: `<b>${t(label)}:</b> ${displayValue}`,
                newLine: true,
            };
        }

        return {
            id,
            schema: {
                type: 'panel',
                items,
            },
            data,
        };
    }

    // ======================================================================
    // Action handlers
    // ======================================================================

    /**
     * Toggle the enabled state of a device.
     *
     * @param {string} deviceId
     * @param {object} context - ActionContext from dm-utils
     * @returns {Promise<{ refresh: boolean }>}
     */
    async toggleEnabled(deviceId, context) {
        const stateId = `${this.adapter.namespace}.${deviceId}.enabled`;
        const current = await this.adapter.getStateAsync(stateId);
        const newVal = !(current?.val);
        await this.adapter.setStateAsync(stateId, { val: newVal, ack: false });
        return { refresh: true };
    }

    /**
     * Two-step wizard: first pick plugin type + name, then configure inputs
     * and plugin-specific settings.
     *
     * @param {object} context - ActionContext from dm-utils
     * @returns {Promise<{ refresh: boolean }>}
     */
    async addDevice(context) {
        // -- Step 1: Select plugin type + device name -----------------------
        const plugins = getAllPlugins();
        if (plugins.length === 0) {
            this.adapter.log.warn('No plugins registered — cannot add device');
            return { refresh: false };
        }

        const typeOptions = plugins.map((p) => ({
            value: p.id,
            label: p.name,
        }));

        const step1Schema = {
            type: 'panel',
            items: {
                _header: {
                    type: 'header',
                    text: { en: 'Select device type', de: 'Gerätetyp auswählen' },
                    size: 4,
                },
                pluginId: {
                    type: 'select',
                    label: { en: 'Device type', de: 'Gerätetyp' },
                    options: typeOptions,
                    noTranslation: false,
                },
                deviceName: {
                    type: 'text',
                    label: { en: 'Device name', de: 'Gerätename' },
                    help: { en: 'Enter a name for this device', de: 'Geben Sie einen Namen für dieses Gerät ein' },
                    maxLength: 64,
                },
                room: {
                    type: 'room',
                    label: { en: 'Room', de: 'Raum' },
                    allowDeactivate: true,
                },
            },
        };

        const step1Data = {
            pluginId: plugins[0].id,
            deviceName: '',
            room: '',
        };

        const step1Result = await context.showForm(step1Schema, {
            data: step1Data,
            title: { en: 'Add virtual device', de: 'Virtuelles Gerät hinzufügen' },
        });

        if (!step1Result) return { refresh: false };

        const selectedPluginId = String(step1Result.pluginId || plugins[0].id);
        const deviceName = String(step1Result.deviceName || '').trim();
        const selectedRoom = String(step1Result.room || '').trim();
        if (!deviceName) return { refresh: false };

        const plugin = getPlugin(selectedPluginId);
        if (!plugin) return { refresh: false };

        // -- Step 2: Configure inputs + settings ----------------------------
        const { schema, data } = buildDeviceForm(plugin);

        const step2Result = await context.showForm(schema, {
            data,
            title: { en: 'Configure device', de: 'Gerät konfigurieren' },
        });

        if (!step2Result) return { refresh: false };

        const parsed = parseFormData(plugin, step2Result);

        // Generate a unique device id
        const deviceId = `${selectedPluginId}-${Date.now().toString(36)}`;

        // Persist device config as a channel object
        /** @type {import('./plugin-interface').StoredDeviceConfig} */
        const storedConfig = {
            pluginId: selectedPluginId,
            deviceName,
            room: selectedRoom,
            inputs: parsed.inputs,
            config: parsed.config,
            chains: parsed.chains,
        };

        // Resolve plugin icon to base64 data-URI for reliable display in ioBroker admin
        const iconDataUri = resolveIconDataUri(plugin.icon);

        /** @type {Record<string,any>} */
        const deviceCommon = { name: deviceName };
        if (iconDataUri) {
            deviceCommon.icon = iconDataUri;
        }

        await this.adapter.setObjectAsync(deviceId, {
            type: 'device',
            common: deviceCommon,
            native: storedConfig,
        });

        // Assign device to room enum
        if (selectedRoom) {
            await this._assignRoom(`${this.adapter.namespace}.${deviceId}`, selectedRoom);
        }

        // Notify main adapter to initialise the new device
        await this.adapter.sendToAsync(this.adapter.namespace, 'deviceAdded', { deviceId });

        return { refresh: true };
    }

    /**
     * Show the device form pre-filled with current config and save changes.
     *
     * @param {string} deviceId
     * @param {object} context - ActionContext from dm-utils
     * @returns {Promise<{ refresh: boolean }>}
     */
    async editDevice(deviceId, context) {
        const obj = await this.adapter.getObjectAsync(deviceId);
        if (!obj) return { refresh: false };

        /** @type {import('./plugin-interface').StoredDeviceConfig} */
        const native = obj.native;
        const plugin = getPlugin(native.pluginId);
        if (!plugin) return { refresh: false };

        // Pre-fill form data from stored config
        /** @type {Record<string, any>} */
        const existingData = {};
        for (const slot of plugin.inputSlots) {
            existingData[`input_${slot.id}`] = native.inputs?.[slot.id] || '';
        }
        for (const [key, defaultVal] of Object.entries(plugin.configDefaults)) {
            existingData[`cfg_${key}`] = native.config?.[key] ?? defaultVal;
        }
        existingData._room = native.room || '';

        // Pre-fill action chain data
        if (plugin.actionChainSlots && native.chains) {
            for (const slotId of Object.keys(plugin.actionChainSlots)) {
                const chain = native.chains[slotId];
                if (Array.isArray(chain)) {
                    existingData[`chain_${slotId}`] = chain.map((step) => ({
                        objectId: step.objectId || '',
                        value: step.value ?? '',
                        waitType: step.waitBefore?.type || 'none',
                        waitMs: step.waitBefore?.ms || 0,
                        waitValue: step.waitBefore?.value ?? '',
                    }));
                }
            }
        }

        const { schema } = buildDeviceForm(plugin, existingData);

        // Add room picker to the form
        schema.items = {
            _roomHeader: {
                type: 'header',
                text: { en: 'General', de: 'Allgemein' },
                size: 5,
            },
            _room: {
                type: 'room',
                label: { en: 'Room', de: 'Raum' },
                allowDeactivate: true,
            },
            ...schema.items,
        };

        const result = await context.showForm(schema, {
            data: existingData,
            title: { en: 'Edit device', de: 'Gerät bearbeiten' },
        });

        if (!result) return { refresh: false };

        const parsed = parseFormData(plugin, result);

        const newRoom = String(result._room || '').trim();

        // Update stored config
        /** @type {import('./plugin-interface').StoredDeviceConfig} */
        const updatedConfig = {
            ...native,
            room: newRoom,
            inputs: parsed.inputs,
            config: parsed.config,
            chains: parsed.chains,
        };

        // Also ensure common.icon is up-to-date (may not have been set on old devices)
        const editIconDataUri = resolveIconDataUri(plugin.icon);
        /** @type {Record<string,any>} */
        const extendCommon = {};
        if (editIconDataUri) {
            extendCommon.icon = editIconDataUri;
        }

        await this.adapter.extendObjectAsync(deviceId, {
            common: extendCommon,
            native: updatedConfig,
        });

        // Update room assignment
        const fullObjId = `${this.adapter.namespace}.${deviceId}`;
        // Remove from old room if changed
        if (native.room && native.room !== newRoom) {
            await this._removeFromRoom(fullObjId, native.room);
        }
        if (newRoom && newRoom !== native.room) {
            await this._assignRoom(fullObjId, newRoom);
        }

        // Notify main adapter to re-initialise the device
        await this.adapter.sendToAsync(this.adapter.namespace, 'deviceUpdated', { deviceId });

        return { refresh: true };
    }

    /**
     * Confirm deletion, remove the device config object and all output states.
     *
     * @param {string} deviceId
     * @param {object} context - ActionContext from dm-utils
     * @returns {Promise<{ refresh: boolean }>}
     */
    async deleteDevice(deviceId, context) {
        const confirmed = await context.showConfirmation({
            en: 'Are you sure you want to delete this device? All associated states will be removed.',
            de: 'Sind Sie sicher, dass Sie dieses Gerät löschen möchten? Alle zugehörigen Datenpunkte werden entfernt.',
        });

        if (!confirmed) return { refresh: false };

        // Remove from room enum if assigned
        const objId = `${this.adapter.namespace}.${deviceId}`;
        const obj = await this.adapter.getObjectAsync(deviceId);
        if (obj?.native?.room) {
            await this._removeFromRoom(objId, obj.native.room);
        }

        // Delete all output states
        const states = await this.adapter.getStatesAsync(`${deviceId}.*`);
        for (const stateId of Object.keys(states)) {
            const relativeId = stateId.replace(`${this.adapter.namespace}.`, '');
            try {
                await this.adapter.delObjectAsync(relativeId);
            } catch {
                // ignore errors for already-deleted states
            }
        }

        // Delete the device object itself
        try {
            await this.adapter.delObjectAsync(deviceId);
        } catch {
            // ignore
        }

        // Notify main adapter
        await this.adapter.sendToAsync(this.adapter.namespace, 'deviceDeleted', { deviceId });

        return { refresh: true };
    }
    // ======================================================================
    // Room enum helpers
    // ======================================================================

    /**
     * Add an object to a room enum.
     * @param {string} objectId - full object ID
     * @param {string} roomId - enum.rooms.* ID (e.g. "enum.rooms.living_room")
     */
    async _assignRoom(objectId, roomId) {
        try {
            const roomObj = await this.adapter.getForeignObjectAsync(roomId);
            if (!roomObj) return;
            const members = roomObj.common?.members || [];
            if (!members.includes(objectId)) {
                members.push(objectId);
                await this.adapter.extendForeignObjectAsync(roomId, {
                    common: { members },
                });
            }
        } catch (e) {
            this.adapter.log.warn(`Could not assign room ${roomId}: ${e}`);
        }
    }

    /**
     * Remove an object from a room enum.
     * @param {string} objectId - full object ID
     * @param {string} roomId - enum.rooms.* ID
     */
    async _removeFromRoom(objectId, roomId) {
        try {
            const roomObj = await this.adapter.getForeignObjectAsync(roomId);
            if (!roomObj) return;
            const members = roomObj.common?.members || [];
            const idx = members.indexOf(objectId);
            if (idx >= 0) {
                members.splice(idx, 1);
                await this.adapter.extendForeignObjectAsync(roomId, {
                    common: { members },
                });
            }
        } catch (e) {
            this.adapter.log.warn(`Could not remove from room ${roomId}: ${e}`);
        }
    }
}

module.exports = VirtualDevicesManagement;

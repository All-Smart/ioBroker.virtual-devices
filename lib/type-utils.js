'use strict';

/**
 * Type utility helpers for ioBroker state value handling.
 *
 * @module type-utils
 */

/**
 * Cast a value to the type expected by an ioBroker datapoint's `common.type`.
 *
 * This is used before every `setForeignStateAsync` call so that config values
 * (which are always strings in JSONConfig) are stored with the correct native type.
 *
 * @param {any} value      - The value to cast.
 * @param {string} commonType - The ioBroker common.type ('boolean', 'number', 'string', 'mixed', 'json', …).
 * @returns {any}          - The cast value; unchanged for unknown/mixed/json types.
 */
function castToType(value, commonType) {
    if (value === null || value === undefined) return value;
    switch (commonType) {
        case 'boolean': {
            if (typeof value === 'boolean') return value;
            const s = String(value).toLowerCase().trim();
            if (s === 'true' || s === '1') return true;
            if (s === 'false' || s === '0') return false;
            return Boolean(value);
        }
        case 'number': {
            const n = Number(value);
            return isNaN(n) ? value : n;
        }
        case 'string':
            return String(value);
        default:
            // mixed, json, file, etc. — leave as-is
            return value;
    }
}

/**
 * Read the `common.type` of a foreign ioBroker object and cast the given value
 * to that type.  Falls back to the original value when the object cannot be
 * read (e.g. objectId is empty, adapter not ready, etc.).
 *
 * @param {ioBroker.Adapter} adapter  - Adapter instance.
 * @param {string}           objectId - Full ioBroker object ID.
 * @param {any}              value    - Value to cast.
 * @param {ioBroker.Logger}  [log]    - Optional logger for debug/warn messages.
 * @returns {Promise<any>}            - Resolved cast value.
 */
async function castToObjectType(adapter, objectId, value, log) {
    if (!objectId) return value;
    try {
        const obj = await adapter.getForeignObjectAsync(objectId);
        if (obj && obj.common && obj.common.type) {
            const cast = castToType(value, obj.common.type);
            if (log && cast !== value) {
                log.debug(`type-utils: cast "${objectId}" value ${JSON.stringify(value)} → ${JSON.stringify(cast)} (${obj.common.type})`);
            }
            return cast;
        }
    } catch (e) {
        if (log) {
            log.warn(`type-utils: could not read object "${objectId}" for type cast: ${e.message}`);
        }
    }
    return value;
}

module.exports = { castToType, castToObjectType };

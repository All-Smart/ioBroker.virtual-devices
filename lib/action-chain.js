'use strict';

const { castToObjectType } = require('./type-utils');

/**
 * Action Chain Executor for virtual-devices adapter.
 *
 * An action chain is a sequential list of commands to control actuators
 * for a single state transition (e.g. "turn ON" or "turn OFF").
 *
 * Chain structure:
 * - Step 1 (base): objectId + value → set immediately
 * - Step 2..n: objectId + value + waitCondition
 *   - waitCondition: { type: "delay", ms: number } XOR { type: "state", objectId, value }
 *
 * @module action-chain
 */

// ---------------------------------------------------------------------------
// JSDoc type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WaitCondition
 * @property {'delay'|'state'}  type     - Wait type.
 * @property {number}           [ms]     - Milliseconds to wait (type=delay).
 * @property {string}           [objectId] - Object to watch (type=state).
 * @property {any}              [value]  - Expected value (type=state).
 * @property {number}           [timeout] - Max wait time in ms for state watch (default 30000).
 */

/**
 * @typedef {Object} ActionChainStep
 * @property {string}          objectId      - ioBroker object ID to write to.
 * @property {any}             value         - Value to write.
 * @property {WaitCondition}   [waitBefore]  - Wait condition BEFORE setting this step's value.
 */

/** @typedef {ActionChainStep[]} ActionChain */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loose comparison for state values (handles string/number/boolean mixing).
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
function looseEquals(actual, expected) {
    // eslint-disable-next-line eqeqeq
    if (actual == expected) return true;
    const strActual = String(actual).toLowerCase();
    const strExpected = String(expected).toLowerCase();
    return strActual === strExpected;
}

// ---------------------------------------------------------------------------
// ActionChainExecutor
// ---------------------------------------------------------------------------

class ActionChainExecutor {
    constructor() {
        /** @type {boolean} */
        this._aborted = false;

        /** @type {ReturnType<typeof setTimeout>|null} */
        this._timer = null;

        /** @type {(() => void)|null} */
        this._unsubscribe = null;

        /** @type {(() => void)|null} */
        this._rejectCurrent = null;
    }

    /**
     * Execute an action chain sequentially.
     *
     * @param {ioBroker.Adapter} adapter - The adapter instance (for setForeignStateAsync, subscribeForeignStatesAsync).
     * @param {ActionChain} chain - The chain steps to execute.
     * @param {ioBroker.Logger} log - Logger instance.
     * @returns {Promise<void>} Resolves when all steps complete, rejects on error or abort.
     */
    async execute(adapter, chain, log) {
        if (!chain || chain.length === 0) {
            return;
        }

        this._aborted = false;

        for (let i = 0; i < chain.length; i++) {
            if (this._aborted) {
                log.debug('Action chain aborted');
                throw new Error('Action chain aborted');
            }

            const step = chain[i];

            // Wait before (steps 2+)
            if (step.waitBefore) {
                log.debug(`Chain step ${i + 1}/${chain.length}: waiting (${step.waitBefore.type})`);
                await this._wait(adapter, step.waitBefore, log);
            }

            if (this._aborted) {
                throw new Error('Action chain aborted');
            }

            // Execute the step — cast value to the target datapoint's native type
            const castValue = await castToObjectType(adapter, step.objectId, step.value, log);
            log.debug(`Chain step ${i + 1}/${chain.length}: setting ${step.objectId} = ${castValue}`);
            await adapter.setForeignStateAsync(step.objectId, castValue, false);
        }

        log.debug(`Action chain completed (${chain.length} steps)`);
    }

    /**
     * Abort a running chain execution.
     */
    abort() {
        this._aborted = true;

        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }

        if (this._rejectCurrent) {
            this._rejectCurrent();
            this._rejectCurrent = null;
        }
    }

    /**
     * @param {ioBroker.Adapter} adapter
     * @param {WaitCondition} condition
     * @param {ioBroker.Logger} log
     * @returns {Promise<void>}
     */
    async _wait(adapter, condition, log) {
        if (condition.type === 'delay') {
            const ms = condition.ms || 0;
            log.debug(`Waiting ${ms}ms (delay)`);
            await this._delay(ms);
        } else if (condition.type === 'state') {
            const timeout = condition.timeout || 30000;
            log.debug(`Waiting for ${condition.objectId} = ${condition.value} (timeout: ${timeout}ms)`);
            await this._waitForState(adapter, condition.objectId, condition.value, timeout, log);
        } else {
            log.warn(`Unknown wait condition type: ${condition.type}`);
        }
    }

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _delay(ms) {
        return new Promise((resolve, reject) => {
            this._rejectCurrent = () => reject(new Error('Action chain aborted'));
            this._timer = setTimeout(() => {
                this._timer = null;
                this._rejectCurrent = null;
                resolve();
            }, ms);
        });
    }

    /**
     * Wait for a foreign state to reach an expected value.
     *
     * @param {ioBroker.Adapter} adapter
     * @param {string} objectId
     * @param {any} expectedValue
     * @param {number} timeoutMs
     * @param {ioBroker.Logger} log
     * @returns {Promise<void>}
     */
    _waitForState(adapter, objectId, expectedValue, timeoutMs, log) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                if (this._timer) {
                    clearTimeout(this._timer);
                    this._timer = null;
                }
                this._unsubscribe = null;
                this._rejectCurrent = null;
            };

            const settle = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (err) reject(err);
                else resolve();
            };

            this._rejectCurrent = () => settle(new Error('Action chain aborted'));

            // Check current value first
            adapter.getForeignStateAsync(objectId).then((currentState) => {
                if (settled) return;

                if (currentState && looseEquals(currentState.val, expectedValue)) {
                    log.debug(`State ${objectId} already at expected value ${expectedValue}`);
                    settle(null);
                    return;
                }

                // Set up a state change listener via adapter's built-in event
                // We use a wrapper that the adapter's onStateChange can call
                const handler = (id, state) => {
                    if (id === objectId && state && looseEquals(state.val, expectedValue)) {
                        log.debug(`State ${objectId} reached expected value ${expectedValue}`);
                        settle(null);
                    }
                };

                // Store handler on the executor so it can be called from outside
                this._stateHandler = handler;
                this._stateHandlerObjectId = objectId;

                this._unsubscribe = () => {
                    this._stateHandler = null;
                    this._stateHandlerObjectId = null;
                };

                // Timeout
                this._timer = setTimeout(() => {
                    log.warn(`Timeout waiting for ${objectId} = ${expectedValue} after ${timeoutMs}ms`);
                    settle(new Error(`Timeout waiting for ${objectId} to reach ${expectedValue}`));
                }, timeoutMs);
            }).catch((err) => {
                settle(err);
            });
        });
    }

    /**
     * Notify the executor of a state change (called by the adapter's onStateChange).
     *
     * @param {string} id - The state ID that changed.
     * @param {ioBroker.State|null} state - The new state.
     */
    onStateChange(id, state) {
        if (this._stateHandler && id === this._stateHandlerObjectId) {
            this._stateHandler(id, state);
        }
    }
}

/**
 * Create and execute an action chain.
 *
 * @param {ioBroker.Adapter} adapter
 * @param {ActionChain} chain
 * @param {ioBroker.Logger} log
 * @returns {Promise<ActionChainExecutor>} The executor (can be used to abort).
 */
async function executeChain(adapter, chain, log) {
    const executor = new ActionChainExecutor();
    // Don't await — return executor immediately so caller can abort
    // The execution runs in background
    const promise = executor.execute(adapter, chain, log);
    executor._promise = promise;
    return executor;
}

/**
 * Create and execute an action chain, awaiting completion.
 *
 * @param {ioBroker.Adapter} adapter
 * @param {ActionChain} chain
 * @param {ioBroker.Logger} log
 * @returns {Promise<void>}
 */
async function executeChainAndWait(adapter, chain, log) {
    const executor = new ActionChainExecutor();
    await executor.execute(adapter, chain, log);
    return executor;
}

module.exports = {
    ActionChainExecutor,
    executeChain,
    executeChainAndWait,
    looseEquals,
};

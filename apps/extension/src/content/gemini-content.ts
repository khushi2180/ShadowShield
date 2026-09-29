/**
 * ShadowShield content script for gemini.google.com
 *
 * Thin entrypoint — all enforcement logic lives in EnforcementController.
 */
import { GeminiAdapter } from '../adapters/gemini';
import { EnforcementUi } from '../enforcement/ui';
import { EnforcementController } from './controller';

const adapter = new GeminiAdapter();
const ui = new EnforcementUi();
const controller = new EnforcementController(adapter, ui);

controller.start();

export const _testAdapter = adapter;

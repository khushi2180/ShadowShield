/**
 * ShadowShield content script for claude.ai
 *
 * Thin entrypoint — all enforcement logic lives in EnforcementController.
 */
import { ClaudeAdapter } from '../adapters/claude';
import { EnforcementUi } from '../enforcement/ui';
import { EnforcementController } from './controller';

const adapter = new ClaudeAdapter();
const ui = new EnforcementUi();
const controller = new EnforcementController(adapter, ui);

controller.start();

export const _testAdapter = adapter;

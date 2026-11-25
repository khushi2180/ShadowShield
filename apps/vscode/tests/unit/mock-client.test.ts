import { describe, it, expect, beforeEach } from 'vitest';
import { MockIpcClient } from '../../src/ipc/mock-client';
import { PROTOCOL_VERSION } from '../../src/ipc/protocol';
import { NEUTRAL_PROMPT_1 } from '../fixtures/neutral-fixtures';

describe('MockIpcClient', () => {
    let client: MockIpcClient;

    beforeEach(() => {
        client = new MockIpcClient();
    });

    it('authenticates with valid 64-character token', async () => {
        const validToken = 'a'.repeat(64);
        const resp = await client.authenticate(validToken);
        expect(resp.authenticated).toBe(true);
    });

    it('rejects authentication with invalid token length', async () => {
        await expect(client.authenticate('short-token')).rejects.toThrow('Invalid authentication token');
    });

    it('returns protocol version and compatible on hello', async () => {
        const resp = await client.hello('0.1.0');
        expect(resp.protocol_version).toBe(PROTOCOL_VERSION);
        expect(resp.compatible).toBe(true);
    });

    it('returns health status', async () => {
        const resp = await client.health();
        expect(resp.agent_running).toBe(true);
        expect(resp.inspection_engine_available).toBe(true);
    });

    it('defaults github_copilot to Coach in Policy mode per IPC contract', async () => {
        const resp = await client.evaluateAiAccess('github_copilot', 'Policy');
        expect(resp.service_id).toBe('github_copilot');
        expect(resp.decision).toBe('Coach');
        expect(resp.reason).toBe('UnknownService');
    });

    it('supports canned Allow state', async () => {
        client.setAllow();
        const access = await client.evaluateAiAccess('github_copilot', 'Policy');
        expect(access.decision).toBe('Allow');

        const inspect = await client.inspect({
            source: 'VSCode',
            ai_service: 'github_copilot',
            content: NEUTRAL_PROMPT_1,
            timestamp: Date.now(),
        });
        expect(inspect.action).toBe('Allow');
        expect(inspect.sanitized_content).toBeNull();
    });

    it('supports canned Redact state', async () => {
        const sanitized = 'sanitized content';
        client.setDlpRedact(sanitized);

        const inspect = await client.inspect({
            source: 'VSCode',
            ai_service: 'github_copilot',
            content: NEUTRAL_PROMPT_1,
            timestamp: Date.now(),
        });
        expect(inspect.action).toBe('Redact');
        expect(inspect.sanitized_content).toBe(sanitized);
    });

    it('fails closed when disconnected', async () => {
        client.disconnect();
        expect(client.isConnected()).toBe(false);
        await expect(client.evaluateAiAccess('github_copilot', 'Policy')).rejects.toThrow(
            'Not connected to agent'
        );
    });
});

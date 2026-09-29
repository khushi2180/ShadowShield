import { describe, it, expect } from 'vitest';
import { ChatGPTAdapter } from '../../src/adapters/chatgpt';
import { ClaudeAdapter } from '../../src/adapters/claude';
import { GeminiAdapter } from '../../src/adapters/gemini';

// Hostname routing tests — verifies each adapter claims only its canonical hostname.
// This is a pure unit test with no DOM or network requirements.

describe('Adapter hostname routing', () => {
    const hostnameTests: Array<{ hostname: string; expectedAdapter: string; shouldMatch: boolean }> = [
        // ChatGPT
        { hostname: 'chatgpt.com',         expectedAdapter: 'ChatGPT', shouldMatch: true  },
        { hostname: 'www.chatgpt.com',     expectedAdapter: 'ChatGPT', shouldMatch: false }, // ChatGPT checks exact host
        // Claude
        { hostname: 'claude.ai',           expectedAdapter: 'Claude',  shouldMatch: true  },
        { hostname: 'www.claude.ai',       expectedAdapter: 'Claude',  shouldMatch: false },
        // Gemini
        { hostname: 'gemini.google.com',   expectedAdapter: 'Gemini',  shouldMatch: true  },
        { hostname: 'google.com',          expectedAdapter: 'Gemini',  shouldMatch: false },
        // Cross-checks
        { hostname: 'claude.ai',           expectedAdapter: 'ChatGPT', shouldMatch: false },
        { hostname: 'chatgpt.com',         expectedAdapter: 'Claude',  shouldMatch: false },
        { hostname: 'gemini.google.com',   expectedAdapter: 'ChatGPT', shouldMatch: false },
    ];

    const adapters = [
        { name: 'ChatGPT', instance: () => new ChatGPTAdapter() },
        { name: 'Claude',  instance: () => new ClaudeAdapter()  },
        { name: 'Gemini',  instance: () => new GeminiAdapter()  },
    ];

    for (const { name, instance } of adapters) {
        describe(name, () => {
            for (const tc of hostnameTests.filter(t => t.expectedAdapter === name)) {
                const qualifier = tc.shouldMatch ? 'matches' : 'does NOT match';
                it(`${qualifier} ${tc.hostname}`, () => {
                    Object.defineProperty(window, 'location', {
                        value: { hostname: tc.hostname },
                        writable: true,
                        configurable: true
                    });
                    const adapter = instance();
                    expect(adapter.matchesCurrentPage()).toBe(tc.shouldMatch);
                });
            }
        });
    }

    describe('Service IDs', () => {
        it('ChatGPTAdapter returns "chatgpt"', () => {
            expect(new ChatGPTAdapter().serviceId()).toBe('chatgpt');
        });
        it('ClaudeAdapter returns "claude"', () => {
            expect(new ClaudeAdapter().serviceId()).toBe('claude');
        });
        it('GeminiAdapter returns "gemini"', () => {
            expect(new GeminiAdapter().serviceId()).toBe('gemini');
        });
    });

    describe('No cross-contamination', () => {
        it('only one adapter matches chatgpt.com', () => {
            Object.defineProperty(window, 'location', { value: { hostname: 'chatgpt.com' }, writable: true, configurable: true });
            const matches = adapters.filter(a => a.instance().matchesCurrentPage());
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe('ChatGPT');
        });

        it('only one adapter matches claude.ai', () => {
            Object.defineProperty(window, 'location', { value: { hostname: 'claude.ai' }, writable: true, configurable: true });
            const matches = adapters.filter(a => a.instance().matchesCurrentPage());
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe('Claude');
        });

        it('only one adapter matches gemini.google.com', () => {
            Object.defineProperty(window, 'location', { value: { hostname: 'gemini.google.com' }, writable: true, configurable: true });
            const matches = adapters.filter(a => a.instance().matchesCurrentPage());
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe('Gemini');
        });

        it('no adapter matches an unsupported host', () => {
            Object.defineProperty(window, 'location', { value: { hostname: 'bard.google.com' }, writable: true, configurable: true });
            const matches = adapters.filter(a => a.instance().matchesCurrentPage());
            expect(matches).toHaveLength(0);
        });
    });
});

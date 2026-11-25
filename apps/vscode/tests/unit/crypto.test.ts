import { describe, it, expect } from 'vitest';
import { hashContent } from '../../src/util/crypto';
import { NEUTRAL_PROMPT_1, NEUTRAL_PROMPT_2, NEUTRAL_CODE_SNIPPET } from '../fixtures/neutral-fixtures';

describe('Crypto Snapshot Hashing', () => {
    it('produces deterministic 64-character SHA-256 hex string', () => {
        const hash1 = hashContent(NEUTRAL_PROMPT_1);
        const hash2 = hashContent(NEUTRAL_PROMPT_1);

        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64);
        expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('distinguishes distinct prompt contents', () => {
        const hash1 = hashContent(NEUTRAL_PROMPT_1);
        const hash2 = hashContent(NEUTRAL_PROMPT_2);
        expect(hash1).not.toBe(hash2);
    });

    it('hashes combined prompt and code selection snapshot correctly', () => {
        const snapshot1 = NEUTRAL_PROMPT_1 + '\n' + NEUTRAL_CODE_SNIPPET;
        const snapshot2 = NEUTRAL_PROMPT_1 + '\n' + NEUTRAL_CODE_SNIPPET;
        const snapshot3 = NEUTRAL_PROMPT_1 + '\n// Different code';

        expect(hashContent(snapshot1)).toBe(hashContent(snapshot2));
        expect(hashContent(snapshot1)).not.toBe(hashContent(snapshot3));
    });
});

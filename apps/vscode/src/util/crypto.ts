import * as crypto from 'crypto';

/**
 * Computes an immutable SHA-256 hex digest of the given content.
 * Used for snapshot binding and stale-content verification.
 */
export function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

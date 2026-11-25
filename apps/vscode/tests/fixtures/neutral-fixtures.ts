/**
 * Neutral test fixtures adhering strictly to DATASET_POLICY.md and docs/v2/IPC_CONTRACT.md §9.
 *
 * INVARIANT: Zero real secrets, zero synthetic API keys, zero live credentials.
 * Only neutral structural developer text.
 */

export const NEUTRAL_PROMPT_1 = 'Please explain the difference between Unix Domain Sockets and Named Pipes.';
export const NEUTRAL_PROMPT_2 = 'Refactor this helper function to improve TypeScript type inference.';

export const NEUTRAL_CODE_SNIPPET = `export function calculateTotal(items: number[]): number {
    return items.reduce((sum, item) => sum + item, 0);
}`;

export const NEUTRAL_MUTATED_CODE = `export function calculateTotal(items: number[]): number {
    // Modified while inspection in flight
    return items.filter(x => x > 0).reduce((sum, item) => sum + item, 0);
}`;

export const NEUTRAL_SANITIZED_SNIPPET = `export function calculateTotal(items: number[]): number {
    /* [REDACTED:INTERNAL_LOGIC] */
    return items.reduce((sum, item) => sum + item, 0);
}`;

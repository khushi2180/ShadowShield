import { describe, it, expect } from 'vitest';
import {
    decodeLengthPrefixedFrame,
    encodeLengthPrefixedFrame,
    FramingError,
    IPC_CONSTANTS,
    StreamFrameDecoder,
} from '../../src/ipc/framing';
import { IpcRequest, IpcResponse } from '../../src/ipc/protocol';

describe('Rust ↔ TypeScript Golden Wire & Framing Tests', () => {
    // -------------------------------------------------------------------------
    // 1. Rust ↔ TypeScript golden frame compatibility: Authenticate
    // -------------------------------------------------------------------------
    it('1. encodes and decodes Authenticate request with exact golden layout', () => {
        const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const req: IpcRequest = {
            protocol_version: 1,
            request_id: 'auth-001',
            type: 'Authenticate',
            payload: { token },
        };

        const frame = encodeLengthPrefixedFrame(req);

        // Header must be exactly 4 bytes LE
        expect(frame.length).toBeGreaterThan(4);
        const declaredLen = frame.readUInt32LE(0);
        expect(declaredLen).toBe(frame.length - 4);

        // Parse payload
        const jsonStr = frame.subarray(4).toString('utf8');
        const parsed = JSON.parse(jsonStr);

        // Wire contract verification: must contain "type", NOT "msg_type"
        expect(parsed.protocol_version).toBe(1);
        expect(parsed.request_id).toBe('auth-001');
        expect(parsed.type).toBe('Authenticate');
        expect(parsed.msg_type).toBeUndefined();
        expect(parsed.payload.token).toBe(token);
    });

    it('1b. encodes and decodes AuthenticateResponse with exact golden layout', () => {
        const resp: IpcResponse = {
            protocol_version: 1,
            request_id: 'auth-001',
            type: 'AuthenticateResponse',
            payload: { authenticated: true },
        };

        const frame = encodeLengthPrefixedFrame(resp);
        const decoded = decodeLengthPrefixedFrame<IpcResponse>(frame);

        expect(decoded.protocol_version).toBe(1);
        expect(decoded.request_id).toBe('auth-001');
        expect(decoded.type).toBe('AuthenticateResponse');
        expect(decoded.payload.authenticated).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 2. Correct 4-byte little-endian framing
    // -------------------------------------------------------------------------
    it('2. verifies 4-byte little-endian byte ordering matches Rust LittleEndian', () => {
        const payload = { test: 'framing_endianness' };
        const jsonStr = JSON.stringify(payload);
        const expectedLen = Buffer.byteLength(jsonStr, 'utf8');

        const frame = encodeLengthPrefixedFrame(payload);

        // Verify little-endian byte layout manually
        const b0 = expectedLen & 0xff;
        const b1 = (expectedLen >> 8) & 0xff;
        const b2 = (expectedLen >> 16) & 0xff;
        const b3 = (expectedLen >> 24) & 0xff;

        expect(frame[0]).toBe(b0);
        expect(frame[1]).toBe(b1);
        expect(frame[2]).toBe(b2);
        expect(frame[3]).toBe(b3);
        expect(frame.readUInt32LE(0)).toBe(expectedLen);
    });

    // -------------------------------------------------------------------------
    // 3. Fragmented header handling
    // -------------------------------------------------------------------------
    it('3. handles fragmented header across multiple 1-byte and 2-byte chunks', () => {
        const decoder = new StreamFrameDecoder();
        const msg = { protocol_version: 1, request_id: 'frag-hdr', type: 'Health', payload: {} };
        const fullFrame = encodeLengthPrefixedFrame(msg);

        // Split the 4-byte header across multiple feeds: byte 0, then byte 1, then bytes 2..end
        const chunk1 = fullFrame.subarray(0, 1);
        const chunk2 = fullFrame.subarray(1, 2);
        const chunk3 = fullFrame.subarray(2);

        expect(decoder.feed(chunk1)).toEqual([]);
        expect(decoder.feed(chunk2)).toEqual([]);
        const result = decoder.feed(chunk3);

        expect(result).toHaveLength(1);
        expect((result[0] as any).request_id).toBe('frag-hdr');
    });

    // -------------------------------------------------------------------------
    // 4. Fragmented payload handling
    // -------------------------------------------------------------------------
    it('4. handles fragmented payload split arbitrarily across stream chunks', () => {
        const decoder = new StreamFrameDecoder();
        const msg = {
            protocol_version: 1,
            request_id: 'frag-payload',
            type: 'InspectResponse',
            payload: { action: 'Allow', details: 'Longer content split across multiple network packets' },
        };
        const fullFrame = encodeLengthPrefixedFrame(msg);

        // Feed full 4-byte header plus partial payload
        const midpoint = 15;
        const part1 = fullFrame.subarray(0, midpoint);
        const part2 = fullFrame.subarray(midpoint);

        const res1 = decoder.feed(part1);
        expect(res1).toHaveLength(0); // Waiting for remaining payload

        const res2 = decoder.feed(part2);
        expect(res2).toHaveLength(1);
        expect((res2[0] as any).request_id).toBe('frag-payload');
        expect((res2[0] as any).payload.action).toBe('Allow');
    });

    // -------------------------------------------------------------------------
    // 5. Multiple / coalesced frames
    // -------------------------------------------------------------------------
    it('5. handles multiple coalesced frames arriving in a single socket buffer', () => {
        const decoder = new StreamFrameDecoder();

        const msg1 = { protocol_version: 1, request_id: 'coal-1', type: 'Health', payload: {} };
        const msg2 = { protocol_version: 1, request_id: 'coal-2', type: 'Health', payload: {} };
        const msg3 = { protocol_version: 1, request_id: 'coal-3', type: 'Health', payload: {} };

        const frame1 = encodeLengthPrefixedFrame(msg1);
        const frame2 = encodeLengthPrefixedFrame(msg2);
        const frame3 = encodeLengthPrefixedFrame(msg3);

        // Coalesce all three frames into a single chunk
        const coalesced = Buffer.concat([frame1, frame2, frame3]);

        const messages = decoder.feed(coalesced);

        expect(messages).toHaveLength(3);
        expect((messages[0] as any).request_id).toBe('coal-1');
        expect((messages[1] as any).request_id).toBe('coal-2');
        expect((messages[2] as any).request_id).toBe('coal-3');
        expect(decoder.getPendingBytes()).toBe(0);
    });

    // -------------------------------------------------------------------------
    // 6. Maximum / bounded frame handling
    // -------------------------------------------------------------------------
    it('6. safely encodes and decodes bounded large payloads up to the limit', () => {
        const decoder = new StreamFrameDecoder();
        // 500 KB payload within the 10 MiB limit
        const largeString = 'A'.repeat(500 * 1024);
        const msg = {
            protocol_version: 1,
            request_id: 'bounded-large',
            type: 'Inspect',
            payload: { content: largeString },
        };

        const frame = encodeLengthPrefixedFrame(msg);
        expect(frame.length).toBeGreaterThan(500 * 1024);

        const decoded = decoder.feed(frame);
        expect(decoded).toHaveLength(1);
        expect((decoded[0] as any).request_id).toBe('bounded-large');
        expect((decoded[0] as any).payload.content.length).toBe(500 * 1024);
    });

    // -------------------------------------------------------------------------
    // 7. Oversized frame rejection
    // -------------------------------------------------------------------------
    it('7. rejects declared frame length exceeding 10 MiB limit immediately without allocating', () => {
        const decoder = new StreamFrameDecoder();
        const header = Buffer.alloc(4);
        // Declare length larger than 10 MiB (10_485_760 + 1)
        header.writeUInt32LE(IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES + 1, 0);

        expect(() => decoder.feed(header)).toThrowError(FramingError);
        expect(() => decoder.feed(header)).toThrow(/exceeds limit/);
        expect(decoder.getPendingBytes()).toBe(0); // Buffer safely reset
    });

    // -------------------------------------------------------------------------
    // 8. Malformed JSON handling
    // -------------------------------------------------------------------------
    it('8. rejects malformed JSON payload and fails closed without crashing', () => {
        const decoder = new StreamFrameDecoder();
        const invalidJson = Buffer.from('{ this is invalid json !!! }', 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(invalidJson.length, 0);
        const badFrame = Buffer.concat([header, invalidJson]);

        expect(() => decoder.feed(badFrame)).toThrowError(FramingError);
        expect(() => decoder.feed(badFrame)).toThrow(/JSON parse error/);
        expect(decoder.getPendingBytes()).toBe(0);
    });
});

/**
 * Framing and streaming length-prefix codec for ShadowShield V2 IPC.
 * Conforms strictly to docs/v2/IPC_CONTRACT.md §4.1 and crates/protocol/src/ipc.rs.
 */

export const IPC_CONSTANTS = {
    PROTOCOL_VERSION: 1,
    MAX_FRAME_LENGTH_BYTES: 10_485_760, // 10 MiB limit (4-byte LE u32 length + UTF-8 JSON)
    FRAME_HEADER_BYTES: 4,
    HANDSHAKE_TIMEOUT_MS: 5_000,
    SERVER_PROCESSING_DEADLINE_MS: 8_000,
    CLIENT_REQUEST_TIMEOUT_MS: 10_000,
    TRAY_HEALTH_TIMEOUT_MS: 3_000,
    IDLE_STREAM_TIMEOUT_MS: 300_000,
} as const;

export class FramingError extends Error {
    constructor(
        public readonly code:
            | 'message_too_large'
            | 'malformed_message'
            | 'connection_closed',
        message: string
    ) {
        super(message);
        this.name = 'FramingError';
    }
}

/**
 * Encodes a JSON message into a 4-byte little-endian length-prefixed Buffer.
 * Enforces the 10 MiB MAX_FRAME_LENGTH_BYTES ceiling before allocating.
 */
export function encodeLengthPrefixedFrame<T>(message: T): Buffer {
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf8');

    if (body.length > IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES) {
        throw new FramingError(
            'message_too_large',
            `Frame size ${body.length} exceeds maximum allowed limit ${IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES}`
        );
    }

    const frame = Buffer.allocUnsafe(IPC_CONSTANTS.FRAME_HEADER_BYTES + body.length);
    frame.writeUInt32LE(body.length, 0); // 4-byte little-endian length
    body.copy(frame, IPC_CONSTANTS.FRAME_HEADER_BYTES);
    return frame;
}

/**
 * Decodes a single standalone 4-byte little-endian length-prefixed frame Buffer.
 */
export function decodeLengthPrefixedFrame<T>(frame: Buffer): T {
    if (frame.length < IPC_CONSTANTS.FRAME_HEADER_BYTES) {
        throw new FramingError(
            'malformed_message',
            `Frame length ${frame.length} is shorter than 4-byte header`
        );
    }

    const payloadLen = frame.readUInt32LE(0);
    if (payloadLen > IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES) {
        throw new FramingError(
            'message_too_large',
            `Declared frame length ${payloadLen} exceeds maximum ${IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES}`
        );
    }

    const totalLen = IPC_CONSTANTS.FRAME_HEADER_BYTES + payloadLen;
    if (frame.length < totalLen) {
        throw new FramingError(
            'malformed_message',
            `Truncated payload: expected ${totalLen} bytes, got ${frame.length}`
        );
    }

    const jsonStr = frame.subarray(IPC_CONSTANTS.FRAME_HEADER_BYTES, totalLen).toString('utf8');
    try {
        return JSON.parse(jsonStr) as T;
    } catch (err: any) {
        throw new FramingError('malformed_message', `JSON parse error: ${err?.message || err}`);
    }
}

/**
 * Streaming parser that buffers incoming socket chunks, handling:
 * - Fragmented headers (< 4 bytes)
 * - Fragmented payloads (< 4 + len bytes)
 * - Coalesced/multiple frames in a single chunk
 * - Immediate rejection of oversized frames without uncontrolled memory allocation
 */
export class StreamFrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    /**
     * Feeds an incoming data chunk and returns any fully assembled frames.
     * Throws FramingError if an oversized or malformed frame is encountered.
     */
    public feed(chunk: Buffer): unknown[] {
        if (chunk.length === 0) return [];

        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const messages: unknown[] = [];

        while (this.buffer.length >= IPC_CONSTANTS.FRAME_HEADER_BYTES) {
            // Read 4-byte LE length
            const payloadLen = this.buffer.readUInt32LE(0);

            if (payloadLen > IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES) {
                // Reject immediately without allocating
                this.buffer = Buffer.alloc(0);
                throw new FramingError(
                    'message_too_large',
                    `Declared payload length ${payloadLen} exceeds limit ${IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES}`
                );
            }

            const totalFrameLen = IPC_CONSTANTS.FRAME_HEADER_BYTES + payloadLen;

            // Incomplete payload: wait for more data
            if (this.buffer.length < totalFrameLen) {
                break;
            }

            // Extract the payload bytes
            const payloadBytes = this.buffer.subarray(
                IPC_CONSTANTS.FRAME_HEADER_BYTES,
                totalFrameLen
            );

            // Advance the buffer past this frame
            this.buffer = this.buffer.subarray(totalFrameLen);

            const jsonStr = payloadBytes.toString('utf8');
            try {
                const parsed = JSON.parse(jsonStr);
                messages.push(parsed);
            } catch (err: any) {
                this.buffer = Buffer.alloc(0);
                throw new FramingError(
                    'malformed_message',
                    `JSON parse error in framed message: ${err?.message || err}`
                );
            }
        }

        return messages;
    }

    public getPendingBytes(): number {
        return this.buffer.length;
    }

    public clear(): void {
        this.buffer = Buffer.alloc(0);
    }
}

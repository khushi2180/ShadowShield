/**
 * ShadowShield V2 Unified IPC Contract Types
 * Verified against crates/protocol/src/ipc.rs and docs/v2/IPC_CONTRACT.md
 * Protocol Version: 1
 */

export const IPC_CONSTANTS = {
  PROTOCOL_VERSION: 1,
  MAX_FRAME_LENGTH_BYTES: 10_485_760, // 10 MiB (4-byte LE u32 length + UTF-8 JSON)
  FRAME_HEADER_BYTES: 4,
  HANDSHAKE_TIMEOUT_MS: 5_000,
  SERVER_PROCESSING_DEADLINE_MS: 8_000,
  CLIENT_REQUEST_TIMEOUT_MS: 10_000,
  TRAY_HEALTH_TIMEOUT_MS: 3_000,
  TRAY_POLL_INTERVAL_MS: 5_000,
  IDLE_STREAM_TIMEOUT_MS: 300_000,
} as const;

export type IpcErrorCode =
  | 'unauthorized'
  | 'unsupported_protocol'
  | 'malformed_message'
  | 'message_too_large'
  | 'invalid_request'
  | 'handshake_timeout'
  | 'request_timeout'
  | 'internal_error';

export interface IpcRequest<TPayload = unknown> {
  protocol_version: number;
  request_id: string;
  type: string;
  payload: TPayload;
}

export interface IpcResponse<TPayload = unknown> {
  protocol_version: number;
  request_id: string;
  type: string;
  payload: TPayload;
}

export interface IpcErrorPayload {
  code: IpcErrorCode | string;
  message: string;
}

export interface IpcErrorResponse {
  protocol_version: number;
  request_id: string | null;
  type: 'Error' | string;
  payload: IpcErrorPayload;
}

export interface AuthenticateRequest {
  token: string;
}

export interface AuthenticateResponse {
  authenticated: boolean;
}

export interface HelloRequest {
  extension_version: string;
  protocol_version: number;
}

export interface HelloResponse {
  agent_version: string;
  protocol_version: number;
  compatible: boolean;
}

export type HealthRequest = Record<string, never>;

export interface HealthResponse {
  agent_running: boolean;
  inspection_engine_available: boolean;
  protocol_version: number;
}

/**
 * Encodes a payload into a 4-byte little-endian length-prefixed UTF-8 JSON frame.
 * Enforces the 10 MiB MAX_FRAME_LENGTH_BYTES guard.
 */
export function encodeLengthPrefixedFrame(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  const body = new TextEncoder().encode(json);
  if (body.byteLength > IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES) {
    throw new Error('message_too_large: frame exceeds 10 MiB limit');
  }
  const frame = new Uint8Array(IPC_CONSTANTS.FRAME_HEADER_BYTES + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, body.byteLength, true); // little-endian
  frame.set(body, IPC_CONSTANTS.FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Validates and decodes a 4-byte little-endian length-prefixed UTF-8 JSON frame.
 * Rejects frames exceeding MAX_FRAME_LENGTH_BYTES before reading payload.
 */
export function decodeLengthPrefixedFrame<T = unknown>(frame: Uint8Array): T {
  if (frame.byteLength < IPC_CONSTANTS.FRAME_HEADER_BYTES) {
    throw new Error('malformed_message: incomplete 4-byte length header');
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint32(0, true);
  if (length > IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES) {
    throw new Error('message_too_large: frame exceeds 10 MiB limit');
  }
  const expectedTotal = IPC_CONSTANTS.FRAME_HEADER_BYTES + length;
  if (frame.byteLength < expectedTotal) {
    throw new Error('malformed_message: truncated payload');
  }
  const payloadBytes = frame.subarray(IPC_CONSTANTS.FRAME_HEADER_BYTES, expectedTotal);
  const json = new TextDecoder().decode(payloadBytes);
  return JSON.parse(json) as T;
}

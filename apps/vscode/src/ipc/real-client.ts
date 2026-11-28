import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { IIpcClient } from './client-interface';
import {
    encodeLengthPrefixedFrame,
    IPC_CONSTANTS,
    StreamFrameDecoder,
} from './framing';
import {
    AiAccessMode,
    AuthenticateRequest,
    AuthenticateResponse,
    EvaluateAiAccessRequest,
    EvaluateAiAccessResponse,
    HealthRequest,
    HealthResponse,
    HelloRequest,
    HelloResponse,
    InspectRequest,
    InspectResponse,
    IpcRequest,
    IpcResponse,
    PROTOCOL_VERSION,
} from './protocol';

export interface RealIpcClientOptions {
    socketPath?: string;
    tokenPath?: string;
    clientRequestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    connectFn?: (socketPath: string) => net.Socket;
}

/**
 * Returns the default canonical runtime directory according to docs/v2/IPC_CONTRACT.md §2.1.
 * macOS: ~/Library/Application Support/ShadowShield/run/
 *
 * NOTE: The ShadowShield V2 IPC transport is macOS-only. Linux and Windows IPC transports
 * are not supported or specified by the approved contract.
 */
export function getDefaultRuntimeDir(): string {
    const home = process.env.HOME || os.homedir();
    return path.join(
        home,
        'Library',
        'Application Support',
        'ShadowShield',
        'run'
    );
}

export function getDefaultSocketPath(): string {
    return path.join(getDefaultRuntimeDir(), 'agent.sock');
}

export function getDefaultTokenPath(): string {
    return path.join(getDefaultRuntimeDir(), 'auth.token');
}

interface PendingRequest {
    type: string;
    resolve: (payload: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * Production Unix Domain Socket IPC Client for ShadowShield V2.
 * Strictly adheres to docs/v2/IPC_CONTRACT.md and crates/protocol/src/ipc.rs.
 */
export class RealIpcClient implements IIpcClient {
    private socket: net.Socket | null = null;
    private decoder: StreamFrameDecoder = new StreamFrameDecoder();
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private requestCounter = 0;
    private authenticated = false;
    private connected = false;
    private connectingPromise: Promise<void> | null = null;

    private readonly socketPath: string;
    private readonly tokenPath: string;
    private readonly requestTimeoutMs: number;
    private readonly handshakeTimeoutMs: number;
    private readonly connectFn: (socketPath: string) => net.Socket;

    constructor(options?: RealIpcClientOptions) {
        this.socketPath = options?.socketPath || getDefaultSocketPath();
        this.tokenPath = options?.tokenPath || getDefaultTokenPath();
        this.requestTimeoutMs =
            options?.clientRequestTimeoutMs ?? IPC_CONSTANTS.CLIENT_REQUEST_TIMEOUT_MS;
        this.handshakeTimeoutMs =
            options?.handshakeTimeoutMs ?? IPC_CONSTANTS.HANDSHAKE_TIMEOUT_MS;
        this.connectFn = options?.connectFn || ((sp) => net.connect(sp));
    }

    public isConnected(): boolean {
        return this.connected && this.authenticated && this.socket !== null && !this.socket.destroyed;
    }

    public getSocketPath(): string {
        return this.socketPath;
    }

    public getTokenPath(): string {
        return this.tokenPath;
    }

    /**
     * Reads the ephemeral authentication token from disk.
     * Enforces the 64-hex-character requirement specified in IPC_CONTRACT.md.
     */
    public readAuthToken(): string {
        if (!fs.existsSync(this.tokenPath)) {
            throw new Error(`Authentication token file not found at ${this.tokenPath}`);
        }
        const token = fs.readFileSync(this.tokenPath, 'utf8').trim();
        if (token.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(token)) {
            throw new Error(
                `Invalid authentication token format (expected 64 hex characters, got length ${token.length})`
            );
        }
        return token;
    }

    /**
     * Connects to the Unix Domain Socket, performs pre-Hello Authenticate,
     * and performs Hello protocol negotiation within the 5,000 ms handshake deadline.
     */
    public async connect(): Promise<void> {
        if (this.isConnected()) return;

        if (this.connectingPromise) {
            return this.connectingPromise;
        }

        this.connectingPromise = this.performConnect();
        try {
            await this.connectingPromise;
        } finally {
            this.connectingPromise = null;
        }
    }

    private async performConnect(): Promise<void> {
        // Step 1: Re-read token from filesystem (supports token rotation / daemon restarts)
        const token = this.readAuthToken();

        // Step 2: Establish socket connection
        const socket = await this.openSocket();
        this.socket = socket;
        this.connected = true;
        this.decoder.clear();

        // Attach receiver listeners
        socket.on('data', (chunk: Buffer) => this.handleData(chunk));
        socket.on('error', (err: Error) => this.handleSocketError(err));
        socket.on('close', () => this.handleSocketClose());

        // Step 3: Enforce Handshake Phase within handshakeTimeoutMs
        const handshakePromise = (async () => {
            // First message: Authenticate
            const authResp = await this.authenticate(token);
            if (!authResp.authenticated) {
                throw new Error('unauthorized: Agent rejected authentication token');
            }
            this.authenticated = true;

            // Second message: Hello
            const helloResp = await this.hello('0.1.0');
            if (helloResp.protocol_version !== PROTOCOL_VERSION || !helloResp.compatible) {
                throw new Error(
                    `unsupported_protocol: Incompatible protocol version ${helloResp.protocol_version}`
                );
            }
        })();

        try {
            await this.withTimeout(
                handshakePromise,
                this.handshakeTimeoutMs,
                'handshake_timeout: Agent handshake did not complete in time'
            );
        } catch (err) {
            this.disconnect();
            throw err;
        }
    }

    private openSocket(): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            let socket: net.Socket;
            try {
                socket = this.connectFn(this.socketPath);
            } catch (err) {
                return reject(err);
            }

            const connectTimeout = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Connection to ${this.socketPath} timed out`));
            }, this.handshakeTimeoutMs);

            socket.once('connect', () => {
                clearTimeout(connectTimeout);
                resolve(socket);
            });

            socket.once('error', (err) => {
                clearTimeout(connectTimeout);
                reject(err);
            });
        });
    }

    private handleData(chunk: Buffer): void {
        let messages: unknown[];
        try {
            messages = this.decoder.feed(chunk);
        } catch (err: any) {
            // Oversized or malformed frame: fail closed immediately
            this.failClosedAllPending(err);
            this.disconnect();
            return;
        }

        for (const msg of messages) {
            this.dispatchIncomingMessage(msg as IpcResponse);
        }
    }

    private dispatchIncomingMessage(resp: IpcResponse): void {
        const requestId = resp.request_id;
        if (!requestId || !this.pendingRequests.has(requestId)) {
            // Contract rule: Unknown or late response IDs must be safely ignored without crashing
            return;
        }

        const pending = this.pendingRequests.get(requestId)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);

        if (resp.type === 'Error') {
            const errPayload = resp.payload as { code?: string; message?: string };
            const code = errPayload?.code || 'internal_error';
            const msg = errPayload?.message || 'ShadowShield agent returned an error';
            pending.reject(new Error(`${code}: ${msg}`));
        } else {
            pending.resolve(resp.payload);
        }
    }

    private handleSocketError(err: Error): void {
        this.failClosedAllPending(err);
        this.disconnect();
    }

    private handleSocketClose(): void {
        this.failClosedAllPending(new Error('connection_closed: Agent connection closed by peer'));
        this.connected = false;
        this.authenticated = false;
        this.socket = null;
    }

    private failClosedAllPending(err: Error): void {
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pendingRequests.clear();
    }

    public disconnect(): void {
        this.connected = false;
        this.authenticated = false;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.failClosedAllPending(new Error('connection_closed: Client disconnected'));
        this.decoder.clear();
    }

    /**
     * Sends an envelope-framed IPC request and awaits the matching response payload.
     * Enforces client request timeout (10,000 ms per contract).
     */
    public async sendRequest<TResponse>(
        type: string,
        payload: any,
        timeoutMs = this.requestTimeoutMs
    ): Promise<TResponse> {
        // Auto-connect if needed (Authenticate and Hello are negotiated during performConnect)
        if (type !== 'Authenticate' && type !== 'Hello' && !this.isConnected()) {
            await this.connect();
        }

        if (!this.socket || this.socket.destroyed) {
            throw new Error('connection_closed: Socket is not connected');
        }

        this.requestCounter++;
        const requestId = `req-${Date.now()}-${this.requestCounter}`;

        const req: IpcRequest = {
            protocol_version: PROTOCOL_VERSION,
            request_id: requestId,
            type,
            payload,
        };

        const frame = encodeLengthPrefixedFrame(req);

        return new Promise<TResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(
                        new Error(
                            `request_timeout: Inspection request timed out after ${timeoutMs}ms. Submission blocked.`
                        )
                    );
                }
            }, timeoutMs);

            this.pendingRequests.set(requestId, {
                type,
                resolve,
                reject,
                timer,
            });

            try {
                this.socket!.write(frame, (err) => {
                    if (err) {
                        clearTimeout(timer);
                        this.pendingRequests.delete(requestId);
                        reject(err);
                    }
                });
            } catch (err: any) {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                reject(err);
            }
        });
    }

    // -------------------------------------------------------------------------
    // IIpcClient Implementation
    // -------------------------------------------------------------------------

    public async authenticate(token: string): Promise<AuthenticateResponse> {
        const payload: AuthenticateRequest = { token };
        return this.sendRequest<AuthenticateResponse>(
            'Authenticate',
            payload,
            this.handshakeTimeoutMs
        );
    }

    public async hello(extensionVersion: string): Promise<HelloResponse> {
        const payload: HelloRequest = {
            extension_version: extensionVersion,
            protocol_version: PROTOCOL_VERSION,
        };
        return this.sendRequest<HelloResponse>('Hello', payload, this.handshakeTimeoutMs);
    }

    public async health(): Promise<HealthResponse> {
        const payload: HealthRequest = {};
        return this.sendRequest<HealthResponse>('Health', payload);
    }

    public async evaluateAiAccess(
        serviceId: string,
        mode: AiAccessMode
    ): Promise<EvaluateAiAccessResponse> {
        const payload: EvaluateAiAccessRequest = {
            service_id: serviceId,
            mode,
        };
        return this.sendRequest<EvaluateAiAccessResponse>('EvaluateAiAccess', payload);
    }

    public async inspect(request: InspectRequest): Promise<InspectResponse> {
        return this.sendRequest<InspectResponse>('Inspect', request);
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(errorMsg));
            }, ms);

            promise.then(
                (val) => {
                    clearTimeout(timer);
                    resolve(val);
                },
                (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            );
        });
    }
}

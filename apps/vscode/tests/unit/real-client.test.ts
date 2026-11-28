import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decodeLengthPrefixedFrame,
    encodeLengthPrefixedFrame,
    StreamFrameDecoder,
} from '../../src/ipc/framing';
import {
    getDefaultRuntimeDir,
    getDefaultSocketPath,
    getDefaultTokenPath,
    RealIpcClient,
} from '../../src/ipc/real-client';
import {
    IpcRequest,
    IpcResponse,
    PROTOCOL_VERSION,
} from '../../src/ipc/protocol';

/**
 * In-memory Socket implementation for sandbox-safe unit testing of RealIpcClient.
 * Emulates the byte-stream Duplex semantics of Unix Domain Sockets without
 * requiring OS network sockets (which are blocked in Windows sandbox).
 */
class InMemorySocket extends net.Socket {
    public peer: InMemorySocket | null = null;
    public isClosed = false;

    constructor() {
        super();
    }

    override _write(
        chunk: any,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void
    ): void {
        if (this.isClosed) {
            callback(new Error('Socket is closed'));
            return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (this.peer && !this.peer.isClosed) {
            setImmediate(() => {
                this.peer?.emit('data', buf);
            });
        }
        callback();
    }

    override _read(_size: number): void {
        // Data pushed via peer _write
    }

    override destroy(error?: Error): this {
        if (this.isClosed) return this;
        this.isClosed = true;
        setImmediate(() => {
            if (error) this.emit('error', error);
            this.emit('close');
            if (this.peer && !this.peer.isClosed) {
                this.peer.isClosed = true;
                setImmediate(() => {
                    this.peer?.emit('close');
                });
            }
        });
        return this;
    }
}

/**
 * Test Server implementing the exact state machine from apps/agent/src/ipc/server.rs
 */
class TestIpcServer {
    public activeSockets: Set<InMemorySocket> = new Set();
    public token: string;
    public isStopped = false;
    public customHandler?: (req: IpcRequest, socket: net.Socket) => boolean | Promise<boolean>;

    constructor(token: string) {
        this.token = token;
    }

    public createClientSocket(): net.Socket {
        if (this.isStopped) {
            throw new Error('connect ECONNREFUSED');
        }

        const clientSock = new InMemorySocket();
        const serverSock = new InMemorySocket();
        clientSock.peer = serverSock;
        serverSock.peer = clientSock;

        this.activeSockets.add(serverSock);
        const decoder = new StreamFrameDecoder();
        let phase: 'PreAuth' | 'PreHello' | 'Operational' = 'PreAuth';

        serverSock.on('data', async (chunk) => {
            let msgs: any[];
            try {
                msgs = decoder.feed(chunk);
            } catch (e: any) {
                serverSock.destroy();
                return;
            }

            for (const req of msgs) {
                if (this.customHandler) {
                    const handled = await this.customHandler(req, serverSock);
                    if (handled) continue;
                }

                if (phase === 'PreAuth') {
                    if (req.type !== 'Authenticate') {
                        const errResp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'Error',
                            payload: {
                                code: 'unauthorized',
                                message: 'Authentication required before protocol interaction',
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(errResp));
                        serverSock.destroy();
                        return;
                    }

                    if (req.payload?.token !== this.token) {
                        const errResp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'Error',
                            payload: {
                                code: 'unauthorized',
                                message: 'Invalid authentication token',
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(errResp));
                        serverSock.destroy();
                        return;
                    }

                    phase = 'PreHello';
                    const authResp: IpcResponse = {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: req.request_id,
                        type: 'AuthenticateResponse',
                        payload: { authenticated: true },
                    };
                    serverSock.write(encodeLengthPrefixedFrame(authResp));
                } else if (phase === 'PreHello') {
                    if (req.type !== 'Hello') {
                        const errResp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'Error',
                            payload: {
                                code: 'unauthorized',
                                message: 'Hello required before operational requests',
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(errResp));
                        serverSock.destroy();
                        return;
                    }

                    if (req.protocol_version !== PROTOCOL_VERSION) {
                        const errResp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'Error',
                            payload: {
                                code: 'unsupported_protocol',
                                message: `Unsupported protocol version: ${req.protocol_version}`,
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(errResp));
                        serverSock.destroy();
                        return;
                    }

                    phase = 'Operational';
                    const helloResp: IpcResponse = {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: req.request_id,
                        type: 'HelloResponse',
                        payload: {
                            agent_version: '0.1.0-dev',
                            protocol_version: PROTOCOL_VERSION,
                            compatible: true,
                        },
                    };
                    serverSock.write(encodeLengthPrefixedFrame(helloResp));
                } else {
                    // Operational phase
                    if (req.type === 'Health') {
                        const resp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'HealthResponse',
                            payload: {
                                agent_running: true,
                                inspection_engine_available: true,
                                protocol_version: PROTOCOL_VERSION,
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(resp));
                    } else if (req.type === 'EvaluateAiAccess') {
                        const resp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'EvaluateAiAccessResponse',
                            payload: {
                                service_id: req.payload?.service_id,
                                classification: 'Approved',
                                mode: req.payload?.mode,
                                decision: 'Allow',
                                reason: 'ApprovedService',
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(resp));
                    } else if (req.type === 'Inspect') {
                        const resp: IpcResponse = {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            type: 'InspectResponse',
                            payload: {
                                detections_count: 0,
                                detections: [],
                                risk_assessment: {
                                    score: 0,
                                    level: 'Low',
                                    primary_detection_index: null,
                                },
                                action: 'Allow',
                                sanitized_content: null,
                                processing_duration_ms: 1,
                            },
                        };
                        serverSock.write(encodeLengthPrefixedFrame(resp));
                    }
                }
            }
        });

        serverSock.on('close', () => {
            this.activeSockets.delete(serverSock);
        });

        setImmediate(() => {
            clientSock.emit('connect');
        });

        return clientSock;
    }

    public stop(): void {
        this.isStopped = true;
        for (const s of this.activeSockets) {
            s.destroy();
        }
        this.activeSockets.clear();
    }
}

describe('RealIpcClient — Protocol & Wire Acceptance Tests', () => {
    let testDir: string;
    let tokenPath: string;
    let token: string;
    let server: TestIpcServer;
    let client: RealIpcClient;

    beforeEach(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-vscode-test-'));
        token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        tokenPath = path.join(testDir, 'auth.token');
        fs.writeFileSync(tokenPath, token, 'utf8');

        server = new TestIpcServer(token);

        client = new RealIpcClient({
            tokenPath,
            socketPath: path.join(testDir, 'agent.sock'),
            handshakeTimeoutMs: 1000,
            clientRequestTimeoutMs: 1000,
            connectFn: () => server.createClientSocket(),
        });
    });

    afterEach(async () => {
        client.disconnect();
        server.stop();
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // -------------------------------------------------------------------------
    // 9. Authentication success
    // -------------------------------------------------------------------------
    it('9. executes Authenticate and Hello handshake successfully on valid token', async () => {
        await client.connect();
        expect(client.isConnected()).toBe(true);

        const health = await client.health();
        expect(health.agent_running).toBe(true);
        expect(health.inspection_engine_available).toBe(true);
        expect(health.protocol_version).toBe(1);
    });

    // -------------------------------------------------------------------------
    // 10. Missing / wrong authentication token
    // -------------------------------------------------------------------------
    it('10a. fails closed if token file does not exist', async () => {
        const nonExistentToken = path.join(testDir, 'does-not-exist.token');
        const badClient = new RealIpcClient({
            tokenPath: nonExistentToken,
            connectFn: () => server.createClientSocket(),
        });

        await expect(badClient.connect()).rejects.toThrow(/Authentication token file not found/);
        expect(badClient.isConnected()).toBe(false);
    });

    it('10b. fails closed if token length is invalid', async () => {
        fs.writeFileSync(tokenPath, 'short-token-less-than-64', 'utf8');
        await expect(client.connect()).rejects.toThrow(/Invalid authentication token format/);
        expect(client.isConnected()).toBe(false);
    });

    it('10c. fails closed if server rejects token with unauthorized', async () => {
        // Write a 64-char hex token that doesn't match the server's token
        const wrongToken = 'f'.repeat(64);
        fs.writeFileSync(tokenPath, wrongToken, 'utf8');

        await expect(client.connect()).rejects.toThrow(/unauthorized/);
        expect(client.isConnected()).toBe(false);
    });

    // -------------------------------------------------------------------------
    // 11. Authenticate-before-Hello ordering
    // -------------------------------------------------------------------------
    it('11. verifies server rejects client that sends Hello before Authenticate', async () => {
        const socket = server.createClientSocket();

        await new Promise((resolve) => socket.once('connect', resolve));

        // Directly send Hello without sending Authenticate first
        const outOfOrderHello: IpcRequest = {
            protocol_version: 1,
            request_id: 'hello-premature',
            type: 'Hello',
            payload: { extension_version: '0.1.0', protocol_version: 1 },
        };
        socket.write(encodeLengthPrefixedFrame(outOfOrderHello));

        const decoder = new StreamFrameDecoder();
        const errResp = await new Promise<any>((resolve) => {
            socket.on('data', (chunk) => {
                const msgs = decoder.feed(chunk);
                if (msgs.length > 0) resolve(msgs[0]);
            });
        });

        expect(errResp.type).toBe('Error');
        expect(errResp.payload.code).toBe('unauthorized');
        expect(errResp.payload.message).toContain('Authentication required');

        socket.destroy();
    });

    // -------------------------------------------------------------------------
    // 12. Hello / protocol-version validation
    // -------------------------------------------------------------------------
    it('12. fails closed if Hello protocol version is unsupported', async () => {
        server.customHandler = (req, socket) => {
            if (req.type === 'Hello') {
                const errResp: IpcResponse = {
                    protocol_version: 1,
                    request_id: req.request_id,
                    type: 'Error',
                    payload: {
                        code: 'unsupported_protocol',
                        message: 'Unsupported protocol version: 999',
                    },
                };
                socket.write(encodeLengthPrefixedFrame(errResp));
                socket.destroy();
                return true;
            }
            return false;
        };

        await expect(client.connect()).rejects.toThrow(/unsupported_protocol/);
        expect(client.isConnected()).toBe(false);
    });

    // -------------------------------------------------------------------------
    // 13. Request / response correlation
    // -------------------------------------------------------------------------
    it('13. correctly correlates concurrent requests by their exact request_id', async () => {
        await client.connect();

        // Dispatch multiple concurrent requests
        const req1 = client.evaluateAiAccess('chatgpt', 'Policy');
        const req2 = client.health();
        const req3 = client.inspect({
            source: 'VSCode',
            ai_service: 'github_copilot',
            content: 'Please explain correlation.',
            timestamp: Date.now(),
        });

        const [res1, res2, res3] = await Promise.all([req1, req2, req3]);

        expect(res1.service_id).toBe('chatgpt');
        expect(res1.decision).toBe('Allow');

        expect(res2.agent_running).toBe(true);

        expect(res3.action).toBe('Allow');
    });

    // -------------------------------------------------------------------------
    // 14. Unknown response IDs
    // -------------------------------------------------------------------------
    it('14. safely discards unknown response IDs without crashing or disrupting queue', async () => {
        await client.connect();

        // Inject an unknown response ID from server
        for (const sock of server.activeSockets) {
            const unknownResp: IpcResponse = {
                protocol_version: 1,
                request_id: 'unknown-spurious-req-id',
                type: 'HealthResponse',
                payload: { agent_running: true, inspection_engine_available: true, protocol_version: 1 },
            };
            sock.write(encodeLengthPrefixedFrame(unknownResp));
        }

        // Regular request must still succeed undisturbed
        const health = await client.health();
        expect(health.agent_running).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 15. Request timeout
    // -------------------------------------------------------------------------
    it('15. rejects pending request with request_timeout when server does not respond', async () => {
        await client.connect();

        // Configure server to swallow EvaluateAiAccess requests (simulating timeout)
        server.customHandler = (req) => {
            if (req.type === 'EvaluateAiAccess') {
                return true; // do not reply
            }
            return false;
        };

        await expect(client.evaluateAiAccess('timeout_service', 'Policy')).rejects.toThrow(
            /request_timeout.*timed out/
        );
    });

    // -------------------------------------------------------------------------
    // 16. Agent disconnect
    // -------------------------------------------------------------------------
    it('16. fails closed and rejects in-flight requests on agent disconnect', async () => {
        await client.connect();

        server.customHandler = (_req, socket) => {
            // Abruptly sever connection
            socket.destroy();
            return true;
        };

        await expect(client.health()).rejects.toThrow(/connection_closed/);
        expect(client.isConnected()).toBe(false);
    });

    // -------------------------------------------------------------------------
    // 17. Reconnect behavior
    // -------------------------------------------------------------------------
    it('17. reconnects and re-authenticates automatically after a server disconnect', async () => {
        await client.connect();
        expect(client.isConnected()).toBe(true);

        // Terminate all current sockets
        for (const s of server.activeSockets) {
            s.destroy();
        }
        await new Promise((r) => setTimeout(r, 50));
        expect(client.isConnected()).toBe(false);

        // Next call automatically triggers reconnect and handshake
        const health = await client.health();
        expect(health.agent_running).toBe(true);
        expect(client.isConnected()).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 18. Token reread / rotation
    // -------------------------------------------------------------------------
    it('18. re-reads rotated auth token from disk upon reconnect', async () => {
        await client.connect();

        // Server rotates token
        const newToken = 'a1b2c3d4e5f60718'.repeat(4);
        server.token = newToken;
        fs.writeFileSync(tokenPath, newToken, 'utf8');

        // Disconnect existing client
        client.disconnect();
        expect(client.isConnected()).toBe(false);

        // Reconnect must re-read disk token and authenticate successfully
        const health = await client.health();
        expect(health.agent_running).toBe(true);
        expect(client.isConnected()).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 19. No raw sensitive logging
    // -------------------------------------------------------------------------
    it('19. does not log raw prompt, tokens, or frames to console', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log');
        const consoleErrorSpy = vi.spyOn(console, 'error');
        const consoleWarnSpy = vi.spyOn(console, 'warn');

        await client.connect();

        const sensitivePrompt = 'SECRET_PASSWORD_12345';
        await client.inspect({
            source: 'VSCode',
            ai_service: 'github_copilot',
            content: sensitivePrompt,
            timestamp: Date.now(),
        });

        const allLogs = [
            ...consoleLogSpy.mock.calls,
            ...consoleErrorSpy.mock.calls,
            ...consoleWarnSpy.mock.calls,
        ]
            .flat()
            .join(' ');

        expect(allLogs).not.toContain(sensitivePrompt);
        expect(allLogs).not.toContain(token);

        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
    });

    // -------------------------------------------------------------------------
    // 20. Fail-closed behavior
    // -------------------------------------------------------------------------
    it('20. fails closed on server error payload, returning error without uninspected dispatch', async () => {
        await client.connect();

        server.customHandler = (req, socket) => {
            if (req.type === 'Inspect') {
                const errResp: IpcResponse = {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: req.request_id,
                    type: 'Error',
                    payload: {
                        code: 'internal_error',
                        message: 'Inspection pipeline failed',
                    },
                };
                socket.write(encodeLengthPrefixedFrame(errResp));
                return true;
            }
            return false;
        };

        await expect(
            client.inspect({
                source: 'VSCode',
                ai_service: 'github_copilot',
                content: 'Test content',
                timestamp: Date.now(),
            })
        ).rejects.toThrow(/internal_error: Inspection pipeline failed/);
    });

    // -------------------------------------------------------------------------
    // Path resolution verification
    // -------------------------------------------------------------------------
    it('verifies standard canonical paths per IPC_CONTRACT.md §2.1', () => {
        const runtimeDir = getDefaultRuntimeDir();
        expect(runtimeDir).toContain('ShadowShield');
        expect(runtimeDir).toContain('run');

        const socketPath = getDefaultSocketPath();
        expect(socketPath).toBe(path.join(runtimeDir, 'agent.sock'));

        const defaultTokenPath = getDefaultTokenPath();
        expect(defaultTokenPath).toBe(path.join(runtimeDir, 'auth.token'));
    });
});

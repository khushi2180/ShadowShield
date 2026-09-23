import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NativeClient } from '../../src/native/client';

// Mock chrome API
const mockPort = {
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn(),
    disconnect: vi.fn()
};

globalThis.chrome = {
    runtime: {
        connectNative: vi.fn().mockReturnValue(mockPort),
        lastError: undefined
    }
} as any;

describe('NativeClient Transport Reliability', () => {
    let client: NativeClient;
    let onMessageCallback: (msg: any) => void;
    let onDisconnectCallback: () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        client = new NativeClient();

        mockPort.onMessage.addListener.mockImplementation((cb) => {
            onMessageCallback = cb;
        });
        mockPort.onDisconnect.addListener.mockImplementation((cb) => {
            onDisconnectCallback = cb;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('1. successful NativeClient response', async () => {
        client.connect();

        const promise = client.sendRequest('Test', { data: 'hello' });

        const postedMsg = mockPort.postMessage.mock.calls[0][0];

        onMessageCallback({
            request_id: postedMsg.request_id,
            type: 'TestResponse',
            payload: { success: true }
        });

        const result = await promise;
        expect(result).toEqual({ success: true });
        expect((client as any).pendingRequests.size).toBe(0);

        // SUCCESS CLEARS TIMER: advance fake timers beyond 10 seconds, nothing else should happen
        vi.advanceTimersByTime(11000);
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('2. native disconnect while one request is pending', async () => {
        client.connect();
        const promise = client.sendRequest('Test', { data: 'hello' });

        onDisconnectCallback();

        await expect(promise).rejects.toThrow('Native host disconnected');
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('3. native disconnect while multiple requests are pending', async () => {
        client.connect();
        const p1 = client.sendRequest('Test', { id: 1 });
        const p2 = client.sendRequest('Test', { id: 2 });

        expect((client as any).pendingRequests.size).toBe(2);
        onDisconnectCallback();

        await expect(p1).rejects.toThrow('Native host disconnected');
        await expect(p2).rejects.toThrow('Native host disconnected');
        expect((client as any).pendingRequests.size).toBe(0);

        // DISCONNECT CLEARS ALL TIMERS: advance fake timers beyond 10 seconds, no second rejection or residual action
        vi.advanceTimersByTime(11000);
    });

    it('4. postMessage immediate failure', async () => {
        client.connect();
        mockPort.postMessage.mockImplementationOnce(() => {
            throw new Error('postMessage failed');
        });

        const promise = client.sendRequest('Test', { data: 'hello' });
        await expect(promise).rejects.toThrow('postMessage failed');

        // Ensure pendingRequests does NOT leak and timer is cleared immediately
        expect((client as any).pendingRequests.size).toBe(0);

        vi.advanceTimersByTime(11000);
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('5. unknown response request_id', async () => {
        client.connect();

        onMessageCallback({
            request_id: 'unknown-id',
            type: 'TestResponse',
            payload: { success: true }
        });

        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('7. service-worker NativeClient rejection (simulated via native Error)', async () => {
        client.connect();

        const promise = client.sendRequest('Test', { data: 'hello' });
        const postedMsg = mockPort.postMessage.mock.calls[0][0];

        onMessageCallback({
            request_id: postedMsg.request_id,
            type: 'Error',
            payload: new Error('Simulated native error')
        });

        await expect(promise).rejects.toEqual(new Error('Simulated native error'));
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('TIMEOUT TEST: host remains connected but never responds', async () => {
        client.connect();

        let error: Error | undefined;
        const promise = client.sendRequest('Test', { data: 'hello' }).catch(e => { error = e; });

        expect((client as any).pendingRequests.size).toBe(1);

        // Fast forward 10 seconds
        vi.advanceTimersByTime(10000);

        await promise;

        expect(error).toBeDefined();
        expect(error?.message).toBe('Native host request timeout');
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('TIMEOUT ISOLATION: concurrent requests, one timeouts, one succeeds', async () => {
        client.connect();

        let errorA: Error | undefined;
        let resultB: any;

        const pA = client.sendRequest('TestA', { data: 'a' }).catch(e => { errorA = e; });
        const pB = client.sendRequest('TestB', { data: 'b' }).then(v => { resultB = v; });

        expect((client as any).pendingRequests.size).toBe(2);

        // Fast forward 5 seconds. Neither resolved yet.
        vi.advanceTimersByTime(5000);
        expect((client as any).pendingRequests.size).toBe(2);

        // B responds normally at 5 seconds
        const postedMsgB = mockPort.postMessage.mock.calls[1][0];
        onMessageCallback({
            request_id: postedMsgB.request_id,
            type: 'TestResponse',
            payload: { success: 'b' }
        });

        await pB;
        expect(resultB).toEqual({ success: 'b' });
        expect((client as any).pendingRequests.size).toBe(1);

        // Fast forward another 5 seconds to trigger A's timeout
        vi.advanceTimersByTime(5000);
        await pA;

        expect(errorA).toBeDefined();
        expect(errorA?.message).toBe('Native host request timeout');
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('RECOVERY AFTER TIMEOUT: independent request succeeds after a timeout', async () => {
        client.connect();

        let errorA: Error | undefined;
        const pA = client.sendRequest('TestA', { data: 'a' }).catch(e => { errorA = e; });

        vi.advanceTimersByTime(10000);
        await pA;
        expect(errorA?.message).toBe('Native host request timeout');

        // Now issue request B
        const pB = client.sendRequest('TestB', { data: 'b' });
        const postedMsgB = mockPort.postMessage.mock.calls[1][0];

        onMessageCallback({
            request_id: postedMsgB.request_id,
            type: 'TestResponse',
            payload: { success: 'b' }
        });

        const resultB = await pB;
        expect(resultB).toEqual({ success: 'b' });
    });

    it('LATE RESPONSE AFTER TIMEOUT: safely ignored', async () => {
        client.connect();

        let errorA: Error | undefined;
        const pA = client.sendRequest('TestA', { data: 'a' }).catch(e => { errorA = e; });
        const postedMsgA = mockPort.postMessage.mock.calls[0][0];

        vi.advanceTimersByTime(10000);
        await pA;
        expect(errorA?.message).toBe('Native host request timeout');
        expect((client as any).pendingRequests.size).toBe(0);

        // Simulate late response
        onMessageCallback({
            request_id: postedMsgA.request_id,
            type: 'TestResponse',
            payload: { success: 'late' }
        });

        // Should be ignored
        expect((client as any).pendingRequests.size).toBe(0);
    });
});

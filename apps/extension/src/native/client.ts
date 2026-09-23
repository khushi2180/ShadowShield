import { IpcRequest, IpcResponse, PROTOCOL_VERSION } from './protocol';

const NATIVE_HOST_NAME = "com.shadowshield.agent";

export class NativeClient {
  private port: chrome.runtime.Port | null = null;
  private pendingRequests: Map<string, { resolve: (val: any) => void, reject: (err: any) => void, timerId: ReturnType<typeof setTimeout> }> = new Map();
  private reqCounter = 0;
  private readonly NATIVE_REQUEST_TIMEOUT_MS = 10000;

  public connect() {
    if (this.port) return;
    this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    this.port.onMessage.addListener(this.onMessage.bind(this));
    this.port.onDisconnect.addListener(this.onDisconnect.bind(this));
    console.log("Native host connected");
  }

  public disconnect() {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
  }

  private onMessage(msg: any) {
    const response = msg as IpcResponse;
    if (response.request_id && this.pendingRequests.has(response.request_id)) {
      const { resolve, reject, timerId } = this.pendingRequests.get(response.request_id)!;
      clearTimeout(timerId);
      this.pendingRequests.delete(response.request_id);

      if (response.type === "Error") {
        reject(response.payload);
      } else {
        resolve(response.payload);
      }
    }
  }

  private onDisconnect() {
    console.warn("Native host disconnected", chrome.runtime.lastError);
    this.port = null;
    for (const { reject, timerId } of this.pendingRequests.values()) {
      clearTimeout(timerId);
      reject(new Error("Native host disconnected"));
    }
    this.pendingRequests.clear();
  }

  public async sendRequest<TResponse>(type: string, payload: any): Promise<TResponse> {
    if (!this.port) {
      throw new Error("Not connected to native host");
    }

    this.reqCounter++;
    const requestId = `req-${Date.now()}-${this.reqCounter}`;

    const request: IpcRequest = {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      type,
      payload
    };

    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error("Native host request timeout"));
        }
      }, this.NATIVE_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timerId });
      try {
        this.port!.postMessage(request);
      } catch (e: any) {
        clearTimeout(timerId);
        this.pendingRequests.delete(requestId);
        reject(e);
      }
    });
  }
}

import { NativeClient } from '../native/client';
import { HelloRequest, HelloResponse } from '../native/protocol';
import { ExtensionMessageEnvelope } from '../native/messages';

const client = new NativeClient();

chrome.runtime.onInstalled.addListener(() => {
  console.log("ShadowShield extension installed");
  client.connect();

  // Test Hello
  client.sendRequest<HelloResponse>("Hello", {
    extension_version: chrome.runtime.getManifest().version,
    protocol_version: 1
  } as HelloRequest)
  .then(resp => {
    console.log("Hello response:", resp);
  })
  .catch(err => {
    console.error("Failed to handshake:", err);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.shadowshield === true) {
        const env = message as ExtensionMessageEnvelope;
        
        // Ensure client is connected
        client.connect();

        client.sendRequest(env.payload.type, env.payload)
            .then(response => {
                sendResponse({ success: true, response });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        
        return true; // Keep message channel open for async response
    }
});

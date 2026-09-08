import { NativeClient } from '../native/client';
import { HelloRequest, HelloResponse } from '../native/protocol';

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

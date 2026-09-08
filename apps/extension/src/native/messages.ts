export interface EvaluateAiAccessMessage {
    type: "EvaluateAiAccess";
    service_id: string;
    mode: "Discovery" | "Policy" | "StrictAllowlist";
}

export interface InspectMessage {
    type: "Inspect";
    source: string;
    ai_service: string;
    content: string;
    timestamp: number;
}

export type ExtensionMessage = EvaluateAiAccessMessage | InspectMessage;

export interface ExtensionMessageEnvelope {
    shadowshield: true;
    request_id: string;
    payload: ExtensionMessage;
}

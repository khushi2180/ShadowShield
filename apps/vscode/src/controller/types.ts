/**
 * Controller and ticket lifecycle types for the VS Code controlled prompt workflow.
 */

export type TicketState =
    | 'PENDING'
    | 'AUTHORIZED'
    | 'DISPATCHING'
    | 'CONSUMED'
    | 'INVALIDATED';

export type CoachReason = 'AiAccess' | 'DataProtection';

export interface DispatchTicket {
    id: string;
    contentHash: string;
    targetService: string; // e.g. "github_copilot"
    state: TicketState;
    rawContent: string;
    authorizedContent?: string;
    action?: 'Allow' | 'Coach' | 'Redact' | 'Block';
    coachReason?: CoachReason;
    createdAt: number;
    modelId?: string;
    modelVendor?: string;
    promptText?: string;
    selectedCode?: string;
}

export interface PromptContext {
    userPrompt: string;
    selectedCode?: string;
    activeFile?: string;
    languageId?: string;
}

export type BannerState =
    | { type: 'None' }
    | {
          type: 'Allow';
          title: string;
          message: string;
      }
    | {
          type: 'Coach';
          coachReason: CoachReason;
          title: string;
          message: string;
      }
    | {
          type: 'Redact';
          title: string;
          message: string;
          sanitizedContent: string;
      }
    | {
          type: 'Block';
          title: string;
          message: string;
      }
    | {
          type: 'Disconnected';
          title: string;
          message: string;
      };

export interface WebviewState {
    promptText: string;
    selectedCode?: string;
    activeFile?: string;
    languageId?: string;
    selectedService: string;
    selectedModelId?: string;
    banner: BannerState;
    isInspecting: boolean;
    lastResponse?: string;
}

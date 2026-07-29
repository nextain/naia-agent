/** Host-owned delivery capability.  A task or LLM selects only a policy id;
 * credentials, remote identifiers, and byte reads remain outside the model. */
export interface OutboundAttachment {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface OutboundDeliveryPort {
  send(input: {
    readonly destinationId: string;
    readonly content: string;
    readonly attachments?: readonly OutboundAttachment[];
    readonly signal?: AbortSignal;
  }): Promise<{ readonly messageId: string }>;
}


export type ChainStatus =
  | 'RECEIVED'
  | 'AUDIO_READY'
  | 'AUDIO_NORMALIZED'
  | 'STT_DONE'
  | 'LLM_DONE'
  | 'PERSISTED'
  | 'TEXT_SENT'
  | 'VOICE_SENT'
  | 'COMPLETED';

export type TurnStatus = ChainStatus | 'FAILED';

export const TURN_CHAIN: readonly ChainStatus[] = [
  'RECEIVED',
  'AUDIO_READY',
  'AUDIO_NORMALIZED',
  'STT_DONE',
  'LLM_DONE',
  'PERSISTED',
  'TEXT_SENT',
  'VOICE_SENT',
  'COMPLETED',
];

export class InvalidTransitionError extends Error {
  readonly from: TurnStatus;
  readonly to: TurnStatus;

  constructor(from: TurnStatus, to: TurnStatus) {
    super(`invalid turn status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isChainStatus(status: TurnStatus): status is ChainStatus {
  return status !== 'FAILED';
}

export function isTerminal(status: TurnStatus): boolean {
  return status === 'COMPLETED';
}

export function nextStatus(current: TurnStatus): TurnStatus | null {
  if (current === 'FAILED' || current === 'COMPLETED') {
    return null;
  }
  const index = TURN_CHAIN.indexOf(current);
  return TURN_CHAIN[index + 1] ?? null;
}

export function canTransition(from: TurnStatus, to: TurnStatus): boolean {
  if (from === 'COMPLETED') {
    return false;
  }
  if (to === 'FAILED') {
    return true;
  }
  if (from === to) {
    return false;
  }
  if (to === 'COMPLETED') {
    return from === 'VOICE_SENT';
  }
  if (from === 'FAILED') {
    return true;
  }
  return nextStatus(from) === to;
}

export function assertTransition(from: TurnStatus, to: TurnStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function chainIndex(status: ChainStatus): number {
  return TURN_CHAIN.indexOf(status);
}

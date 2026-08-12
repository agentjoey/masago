import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  nextStatus,
  TURN_CHAIN,
  type ChainStatus,
  type TurnStatus,
} from '../../src/sessions/turnStateMachine.js';

const ALL_STATUSES: readonly TurnStatus[] = [...TURN_CHAIN, 'FAILED'];

function adjacentPairs(): Array<[ChainStatus, ChainStatus]> {
  const pairs: Array<[ChainStatus, ChainStatus]> = [];
  for (let i = 0; i < TURN_CHAIN.length - 1; i += 1) {
    pairs.push([TURN_CHAIN[i] as ChainStatus, TURN_CHAIN[i + 1] as ChainStatus]);
  }
  return pairs;
}

describe('turnStateMachine', () => {
  it('exhaustively allows every legal chain transition', () => {
    for (const [from, to] of adjacentPairs()) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it('allows FAILED from every non-terminal status', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'COMPLETED') {
        continue;
      }
      expect(canTransition(from, 'FAILED')).toBe(true);
    }
  });

  it('rejects skipping steps', () => {
    expect(canTransition('RECEIVED', 'STT_DONE')).toBe(false);
    expect(canTransition('AUDIO_READY', 'LLM_DONE')).toBe(false);
    expect(canTransition('STT_DONE', 'TEXT_SENT')).toBe(false);
    expect(() => assertTransition('RECEIVED', 'LLM_DONE')).toThrow(InvalidTransitionError);
  });

  it('rejects moving backwards', () => {
    expect(canTransition('LLM_DONE', 'STT_DONE')).toBe(false);
    expect(canTransition('TEXT_SENT', 'RECEIVED')).toBe(false);
    expect(() => assertTransition('LLM_DONE', 'STT_DONE')).toThrow(InvalidTransitionError);
  });

  it('rejects any transition out of COMPLETED', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition('COMPLETED', to)).toBe(false);
    }
    expect(() => assertTransition('COMPLETED', 'STT_DONE')).toThrow(InvalidTransitionError);
  });

  it('rejects COMPLETED from anything except VOICE_SENT', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'VOICE_SENT' || from === 'FAILED') {
        continue;
      }
      expect(canTransition(from, 'COMPLETED')).toBe(false);
    }
    expect(canTransition('VOICE_SENT', 'COMPLETED')).toBe(true);
  });

  it('allows resume transitions out of FAILED to non-terminal chain statuses', () => {
    expect(canTransition('FAILED', 'VOICE_SENT')).toBe(true);
    expect(canTransition('FAILED', 'STT_DONE')).toBe(true);
    expect(canTransition('FAILED', 'FAILED')).toBe(true);
    expect(canTransition('FAILED', 'COMPLETED')).toBe(false);
  });

  it('rejects self-transitions on the chain', () => {
    for (const status of TURN_CHAIN) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('nextStatus walks the chain and stops at the end', () => {
    expect(nextStatus('RECEIVED')).toBe('AUDIO_READY');
    expect(nextStatus('AUDIO_READY')).toBe('AUDIO_NORMALIZED');
    expect(nextStatus('AUDIO_NORMALIZED')).toBe('STT_DONE');
    expect(nextStatus('STT_DONE')).toBe('LLM_DONE');
    expect(nextStatus('LLM_DONE')).toBe('PERSISTED');
    expect(nextStatus('PERSISTED')).toBe('TEXT_SENT');
    expect(nextStatus('TEXT_SENT')).toBe('VOICE_SENT');
    expect(nextStatus('VOICE_SENT')).toBe('COMPLETED');
    expect(nextStatus('COMPLETED')).toBeNull();
    expect(nextStatus('FAILED')).toBeNull();
  });

  it('isTerminal only for COMPLETED', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    for (const status of ALL_STATUSES) {
      if (status !== 'COMPLETED') {
        expect(isTerminal(status)).toBe(false);
      }
    }
  });

  it('InvalidTransitionError carries from and to', () => {
    const error = new InvalidTransitionError('COMPLETED', 'STT_DONE');
    expect(error.from).toBe('COMPLETED');
    expect(error.to).toBe('STT_DONE');
    expect(error.name).toBe('InvalidTransitionError');
  });
});

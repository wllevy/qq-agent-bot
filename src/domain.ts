import type { Snapshot, Turn } from './types.js';

export type SessionStatus = 'running' | 'approval' | 'input' | 'error' | 'failed' | 'interrupted' | 'unloaded' | 'idle';
export const terminal = (turn: Turn) => ['completed', 'failed', 'interrupted'].includes(turn.status);
// A newly visible persisted turn can temporarily look interrupted with no items.
// Do not publish or acknowledge this placeholder as a finished conversation.
export const reportableTerminal = (turn: Turn) => terminal(turn) && Boolean(turn.error?.message || turn.items.some(item =>
  item.type === 'agentMessage' && item.text?.trim() || item.type === 'userMessage' && (item.text?.trim() || item.content?.length)));
export const canReportTurn = (snapshot: Snapshot, turn: Turn) => reportableTerminal(turn)
  && !(snapshot.thread.status.type === 'active' && snapshot.turns[0]?.id === turn.id && turn.status !== 'completed');
export function sessionStatus(snapshot: Snapshot): SessionStatus {
  const { type, activeFlags = [] } = snapshot.thread.status;
  if (activeFlags.includes('waitingOnApproval')) return 'approval';
  if (activeFlags.includes('waitingOnUserInput')) return 'input';
  if (type === 'systemError') return 'error';
  if (type === 'active' || snapshot.turns[0]?.status === 'inProgress' && type !== 'notLoaded') return 'running';
  if (snapshot.turns[0]?.status === 'failed') return 'failed';
  if (snapshot.turns[0]?.status === 'interrupted') return 'interrupted';
  return type === 'notLoaded' ? 'unloaded' : 'idle';
}
export const canDispatch = (snapshot: Snapshot) => !['running', 'approval', 'input', 'error'].includes(sessionStatus(snapshot));

export class SubmissionError extends Error {
  constructor(message: string, public outcome: 'retryable' | 'rejected' | 'uncertain') { super(message); }
}

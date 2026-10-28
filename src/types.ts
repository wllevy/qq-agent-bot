export interface Thread {
  managed?: boolean;
  machine?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  updatedAt: number;
  source?: unknown;
  status: { type: string; activeFlags?: string[] };
}
export interface AgentItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  content?: { type: string; text?: string }[];
  command?: string;
  status?: string;
  exitCode?: number | null;
  changes?: { path: string }[];
  server?: string;
  tool?: string;
  namespace?: string | null;
  arguments?: unknown;
  query?: string;
  path?: string;
  durationMs?: number;
}
export interface ActivityEntry {
  turnId: string;
  item: AgentItem;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}
export interface SnapshotOptions { activity?: boolean }
export interface Turn {
  id: string;
  status: string;
  items: AgentItem[];
  startedAt?: number | null;
  completedAt?: number | null;
  error?: { message?: string } | null;
}
export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description?: string }[];
}
export interface ModelSettings { model?: string; effort?: string }
export interface Snapshot {
  thread: Thread;
  turns: Turn[];
  activity?: { turnId: string; entries: ActivityEntry[]; error?: string };
  pendingAction?: { id: string; kind: 'approval' | 'input'; text: string };
}
export interface Subscription { persistent: boolean; seen: string[]; attention?: string; terminalStatuses?: Record<string, string>; replies: { inputId: string; turnId?: string }[] }
export interface DirectoryEntry { path: string; lastUsed: number }
export interface CreationMenu { token: string; machine?: string; choices: string[]; query: string; page: number }
export interface Chat {
  creationMenu?: CreationMenu;
  current?: string;
  menu: string[];
  menuMachine?: string;
  menuQuery?: string;
  settingsMenu?: { thread: string; kind: 'model' | 'effort'; values: string[] };
  page: number;
  subscriptions: Record<string, Subscription>;
}
export interface Outgoing {
  id: string;
  user: string;
  kind: 'reply' | 'notification';
  thread?: string;
  replyTo?: string;
  buttons?: Button[];
  acknowledge?: string[];
  turn?: string;
  text: string;
  parts: string[];
  part: number;
  attempts: number;
  retryAt: number;
  fileId?: string;
}
export interface QueuedInput {
  id: string;
  user: string;
  thread: string;
  text: string;
  state: 'queued' | 'sending' | 'uncertain' | 'rejected';
  error?: string;
  threadLabel?: string;
  waitReason?: string;
  fileIds?: string[];
}
export interface Incoming {
  id: string;
  user: string;
  text: string;
  messageId: string;
  reference?: string;
  stopTarget?: { thread: string; turn?: string };
  fileIds?: string[];
  attachmentThread?: string;
  creation?: { machine: string; cwd: string; thread?: Thread };
}
export interface State {
  version: 4;
  inbox: Incoming[];
  chats: Record<string, Chat>;
  outbox: Outgoing[];
  inputs: QueuedInput[];
  received: string[];
  refs: Record<string, { user: string; thread: string }>;
  files?: Record<string, TransferFile>;
  directories?: Record<string, DirectoryEntry[]>;
}
export interface Attachment { url: string; filename?: string; content_type: string; size?: number }
export interface PreparedFile { path: string; name: string; mime: string }
export interface TransferFile {
  id: string; user: string; thread: string; name: string; mime: string;
  direction: 'in' | 'out'; status: 'pending' | 'ready' | 'listed' | 'failed';
  url?: string; sourcePath?: string; localPath?: string; remotePath?: string;
  turn?: string; claimedBy?: string; size?: number;
  attempts: number; retryAt: number; error?: string;
  upload?: { info: string; expiresAt: number };
}
export interface Button { label: string; command: string }
export interface Sender {
  send(user: string, text: string, options?: { replyTo?: string; thread?: string; buttons?: Button[] }): Promise<string[]>;
  sendFile?(user: string, file: TransferFile, uploaded: (upload: { info: string; expiresAt: number }) => void): Promise<string[]>;
}
export interface CodexPort {
  readonly machines?: readonly string[];
  backendLabel?(machine: string): string;
  canCreate?(machine: string): boolean;
  create?(machine: string, cwd: string | undefined, requestId: string, sourceId?: string, settings?: ModelSettings): Promise<Thread>;
  respond?(id: string, actionId: string, answer: string): Promise<void>;
  qualify?(id: string): string;
  close?(): void | Promise<void>;
  list(machine?: string): Promise<Thread[]>;
  snapshot(id: string, options?: SnapshotOptions): Promise<Snapshot>;
  history?(id: string, cursor?: string): Promise<{ turns: Turn[]; nextCursor?: string | null }>;
  models(id: string): Promise<ModelOption[]>;
  updateSettings(id: string, settings: ModelSettings): Promise<Thread>;
  prepare(id: string): Promise<void>;
  send(id: string, text: string, inputId: string, files?: PreparedFile[]): Promise<Turn>;
  readFile?(id: string, path: string, maxBytes: number): Promise<Buffer>;
  writeFile?(id: string, path: string, data: Buffer): Promise<void>;
  interrupt(id: string, turnId: string): Promise<void>;
}

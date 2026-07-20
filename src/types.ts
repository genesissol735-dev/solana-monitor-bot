export interface WalletInfo {
  publicKey: string;
  nickname?: string;
  createdAt?: Date;
  isActive: boolean;
}

export interface BalanceState {
  wallet: string;
  mint: string; // 'sol' for SOL, mint address for SPL tokens
  balance: bigint;
  lastUpdated: Date;
}

export interface DetectionEvent {
  id: string;
  wallet: string;
  mint: string;
  amount: bigint;
  tokenAccount?: string;
  timestamp: Date;
  status: 'pending' | 'approved' | 'rejected' | 'transferred' | 'failed';
  discordMessageId?: string;
  transactionSignature?: string;
  approvedBy?: string;
  approvedAt?: Date;
  viaContract?: boolean; // Added for contract monitoring
}

export interface TransferConfig {
  rateLimitPerMinute: number;
  minAmountSol: bigint;
  minAmountToken: bigint;
  solReserveLamports: bigint;
  confirmationTimeoutSeconds: number;
}

export interface AgentConfig {
  rpcUrl: string;
  rpcWebSocketUrl: string;
  pollIntervalSeconds: number;
  adminKeypairPath: string;
  senderKeypairPaths: string[];
  dbPath: string;
  discord: DiscordConfig;
  transfer: TransferConfig;
  maxRetryAttempts: number;
  retryDelayMs: number;
  debounceThresholdPercent: number;
}

export interface DiscordConfig {
  token: string;
  guildId: string;
  channelId: string;
  adminUserIds: string[];
}

export interface ManualTransferRequest {
  wallet: string;
  asset: string; // 'sol' or mint address
  amount: bigint;
  tokenAccount?: string;
  initiatedBy: string;
}

export interface DelegationState {
  wallet: string;
  isActive: boolean;
  expiration: Date;
  maxAmount?: string;
  lastUpdated: Date;
}

export interface ContractTransferEvent {
  wallet: string;
  amount: bigint;
  to: string;
  mint: string;
  timestamp: number;
  signature?: string;
}

export interface DelegationGrantedEvent {
  wallet: string;
  expiration: number;
  maxAmount?: bigint;
}

// Export AgentDatabase class type
export { AgentDatabase } from './database.js';

export interface DelegationDetectedEvent {
  wallet: string;
  expiration: number;
  maxAmount: number;
  autoAdded: boolean;
}
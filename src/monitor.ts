import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import { AgentDatabase } from './database.js';
import { DetectionEvent } from './types.js';
import { logger } from './utils.js';
import { appEvents, EVENTS } from './events.js';

// CONFIGURATION
const PROGRAM_ID_STR = "8mKiRaRw4TaMhdMeCjqMtXFxgc4Kv863nLECCcZrYb9F";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // Devnet USDC
// 🟢 NEW: The contract uses 32 bytes of zeros for the Native SOL seed
const NATIVE_MINT_SEED = new PublicKey("11111111111111111111111111111111"); 

const SUPPORTED_MINTS = [WSOL_MINT, USDC_MINT];

// 🟢 UPDATED IDL: Matches the current 'UserProfileState' structure
const IDL = {
  "address": PROGRAM_ID_STR,
  "metadata": { "name": "hybrid_token", "version": "0.1.0" },
  "instructions": [], // Instructions omitted for monitor brevity
  "accounts": [
    {
      "name": "UserProfileState",
      "discriminator": [189, 252, 164, 3, 222, 62, 147, 40]
    }
  ],
  "types": [
    {
      "name": "UserProfileState",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "owner", "type": "pubkey" },
          { "name": "vaultTokenAccount", "type": "pubkey" },
          { "name": "assetMint", "type": "pubkey" },
          { "name": "delegatedAmount", "type": "u64" },
          { "name": "vaultSolBalance", "type": "u64" },
          { "name": "isEnabled", "type": "bool" }
        ]
      }
    }
  ]
};

// 🟢 UPDATED SIZE: 
// Disc(8) + Owner(32) + VaultToken(32) + Mint(32) + DelAmount(8) + SolBal(8) + Enabled(1) = 121 bytes
const DELEGATION_STATE_SIZE = 121;
const SEED_PREFIX = "secure-monitor-v1";

export class WalletMonitor {
  private connection: Connection;
  private db: AgentDatabase;
  private pollInterval: number;
  private debounceThreshold: number;
  private monitoredWallets: Set<string> = new Set();
  private accountSubscriptions: Map<string, number> = new Map();
  private program: anchor.Program;
  private delegationSubscriptions: Map<string, number> = new Map();

  constructor(
    connection: Connection, 
    db: AgentDatabase, 
    pollInterval: number,
    debounceThreshold: number
  ) {
    this.connection = connection;
    this.db = db;
    this.pollInterval = pollInterval;
    this.debounceThreshold = debounceThreshold;

    const provider = new anchor.AnchorProvider(
      connection,
      {} as anchor.Wallet,
      { commitment: 'confirmed' }
    );
    
    anchor.setProvider(provider);
    
    // @ts-ignore
    this.program = new anchor.Program(IDL, provider);

    logger.info(`🎯 Monitor initialized for Program: ${PROGRAM_ID.toString()}`);
  }

  async initialize(wallets: string[]): Promise<void> {
    logger.info(`🎯 MONITOR INITIALIZE with ${wallets.length} wallets`);
    
    for (const wallet of wallets) {
      this.addWallet(wallet);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await this.startDelegationDetection();
    this.startPolling();
    logger.info('🎯 MONITOR RUNNING');
  }

  // ========== AUTOMATIC DELEGATION DETECTION ==========

  private async startDelegationDetection(): Promise<void> {
    try {
      logger.info('🚨 Starting Delegation Detection Systems');
      await this.monitorDelegationAccounts();
      await this.scanAllExistingDelegations();
      logger.info('✅ Delegation detection active');
    } catch (error) {
      logger.error('❌ Delegation detection failed to start:', error);
    }
  }

  private async monitorDelegationAccounts(): Promise<void> {
    try {
      const subscriptionId = this.connection.onProgramAccountChange(
        PROGRAM_ID,
        async (accountInfo) => {
          try {
            if (accountInfo.accountInfo.data.length === DELEGATION_STATE_SIZE) {
              await this.processPotentialDelegationAccount(accountInfo.accountId, accountInfo.accountInfo.data);
            }
          } catch (error) {
            logger.error('Error processing program account change:', error);
          }
        },
        'confirmed',
        [
          { dataSize: DELEGATION_STATE_SIZE } 
        ]
      );

      this.delegationSubscriptions.set('program-accounts', subscriptionId);
      logger.info('Started monitoring for new delegation accounts');
    } catch (error) {
      logger.error('Failed to setup delegation account monitoring:', error);
    }
  }

  private async scanAllExistingDelegations(): Promise<void> {
    try {
      logger.info('🔍 Scanning for existing delegations...');
      
      const allAccounts = await this.connection.getProgramAccounts(
        PROGRAM_ID,
        {
          filters: [
            { dataSize: DELEGATION_STATE_SIZE }
          ]
        }
      );

      logger.info(`📊 Found ${allAccounts.length} delegation accounts`);
      
      for (const { pubkey, account } of allAccounts) {
        await this.processPotentialDelegationAccount(pubkey, account.data);
      }
    } catch (error) {
      logger.error('❌ Error scanning existing delegations:', error);
    }
  }

  private async processPotentialDelegationAccount(accountId: PublicKey, accountData: Buffer): Promise<void> {
    try {
      const delegationData = this.parseDelegationAccount(accountId, accountData);
      
      if (delegationData && delegationData.isActive) {
        await this.handleNewDelegationDetected(delegationData);
      }
    } catch (error) {
      // Ignore parse errors
    }
  }

  // 🟢 UPDATED PARSER: Matches the 121-byte UserProfileState layout
  private parseDelegationAccount(accountId: PublicKey, accountData: Buffer): any {
    try {
        if (accountData.length !== DELEGATION_STATE_SIZE) return null;

        // Offsets updated for UserProfileState
        const owner = new PublicKey(accountData.slice(8, 40));
        const vaultTokenAcc = new PublicKey(accountData.slice(40, 72));
        const assetMint = new PublicKey(accountData.slice(72, 104));
        const delegatedAmount = accountData.readBigUInt64LE(104);
        const vaultSolBalance = accountData.readBigUInt64LE(112);
        const isEnabled = accountData[120] !== 0;

        // 🟢 NEW PDA DERIVATION: Uses "secure-monitor-v1" and NATIVE_MINT_SEED check
        const effectiveMintSeed = (assetMint.equals(NATIVE_MINT_SEED) || assetMint.equals(WSOL_MINT))
            ? NATIVE_MINT_SEED 
            : assetMint;

        const [expectedPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from(SEED_PREFIX), 
                owner.toBuffer(),
                effectiveMintSeed.toBuffer()
            ],
            PROGRAM_ID
        );

        if (!accountId.equals(expectedPda)) {
            return null;
        }

        return {
            user: owner.toString(),
            mint: assetMint.toString(),
            maxAmount: delegatedAmount.toString(),
            isActive: isEnabled,
            account: accountId.toString(),
            solBalance: vaultSolBalance.toString()
        };
    } catch (error) {
        return null;
    }
  }

  private async handleNewDelegationDetected(data: any): Promise<void> {
    const wallet = data.user;
    const isMonitored = this.monitoredWallets.has(wallet);
    
    if (!isMonitored) {
        logger.info(`🔄 New delegation detected: ${wallet} (Mint: ${data.mint})`);
        
        await this.db.addMonitoredWallet({
            publicKey: wallet,
            nickname: `Auto-${wallet.substring(0, 4)}`,
            isActive: true,
             createdAt: new Date()
        });

        this.addWallet(wallet);

        appEvents.emit(EVENTS.DELEGATION_DETECTED, {
            wallet,
            mint: data.mint,
            autoAdded: true
        });
    }

    await this.db.updateDelegationState({
        wallet,
        isActive: data.isActive,
        expiration: new Date(Date.now() + 31536000000),
        maxAmount: data.maxAmount,
        lastUpdated: new Date()
    });
  }

  // ========== WALLET MONITORING ==========

  addWallet(wallet: string): void {
    if (!this.monitoredWallets.has(wallet)) {
      this.monitoredWallets.add(wallet);
      this.setupWalletBalanceMonitoring(wallet);
      this.checkUserDelegations(wallet).catch(console.error);
    }
  }

  removeWallet(wallet: string): void {
    if (this.monitoredWallets.has(wallet)) {
      this.monitoredWallets.delete(wallet);
      const subId = this.accountSubscriptions.get(wallet);
      if (subId) {
        this.connection.removeAccountChangeListener(subId);
        this.accountSubscriptions.delete(wallet);
      }
    }
  }

  private async setupWalletBalanceMonitoring(wallet: string): Promise<void> {
    try {
      const publicKey = new PublicKey(wallet);
      
      const subId = this.connection.onAccountChange(
        publicKey,
        (accountInfo) => {
           this.handleBalanceChange(wallet, WSOL_MINT.toString(), BigInt(accountInfo.lamports));
        },
        'confirmed'
      );
      this.accountSubscriptions.set(wallet, subId);

      await this.monitorTokenAccounts(wallet);

    } catch (error) {
      logger.error(`Failed to setup monitoring for ${wallet}:`, error);
    }
  }

  private async monitorTokenAccounts(wallet: string): Promise<void> {
    try {
      const publicKey = new PublicKey(wallet);
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      for (const { pubkey, account } of tokenAccounts.value) {
        const accountInfo = await getAccount(this.connection, pubkey);
        const mintStr = accountInfo.mint.toString();

        if (mintStr !== WSOL_MINT.toString() && mintStr !== USDC_MINT.toString()) {
            continue;
        }

        const currentBalance = BigInt(accountInfo.amount.toString());
        await this.handleBalanceChange(wallet, mintStr, currentBalance, pubkey.toString());
      }
    } catch (error) {
      logger.error(`Failed to monitor token accounts for ${wallet}:`, error);
    }
  }

  private async handleBalanceChange(
    wallet: string, 
    mint: string, 
    newBalance: bigint, 
    tokenAccount?: string
  ): Promise<void> {
    try {
      const previousState = await this.db.getBalanceState(wallet, mint);
      
      if (!previousState) {
        await this.db.updateBalanceState({
          wallet,
          mint,
          balance: newBalance,
          lastUpdated: new Date()
        });
        return;
      }

      const previousBalance = previousState.balance;
      
      if (newBalance > previousBalance) {
        const increase = newBalance - previousBalance;
        const increasePercent = Number(increase) / Number(previousBalance || 1n) * 100;

        if (increasePercent >= this.debounceThreshold || previousBalance === 0n) {
          await this.createDetectionEvent(wallet, mint, increase, tokenAccount);
        }
      }

      await this.db.updateBalanceState({
        wallet,
        mint,
        balance: newBalance,
        lastUpdated: new Date()
      });

    } catch (error) {
      logger.error(`Error handling balance change for ${wallet}:`, error);
    }
  }

  private async createDetectionEvent(wallet: string, mint: string, amount: bigint, tokenAccount?: string): Promise<void> {
    const event: Omit<DetectionEvent, 'id'> = {
      wallet,
      mint,
      amount,
      tokenAccount,
      timestamp: new Date(),
      status: 'pending'
    };

    const eventId = await this.db.createDetectionEvent(event);
    logger.info(`💰 Balance Increase Detected: ${wallet} +${amount} (Mint: ${mint})`);
    appEvents.emit(EVENTS.BALANCE_INCREASE, eventId);
  }

  private startPolling(): void {
    setInterval(async () => {
      for (const wallet of this.monitoredWallets) {
        await this.checkUserDelegations(wallet);
      }
    }, this.pollInterval * 1000);
  }

  private async checkUserDelegations(wallet: string): Promise<void> {
     try {
        const userPubkey = new PublicKey(wallet);
        
        for (const mint of SUPPORTED_MINTS) {
            // 🟢 UPDATED: Use the new seed pattern for manual polling
            const mintSeed = (mint.equals(WSOL_MINT)) ? NATIVE_MINT_SEED : mint;

            const [delegationPda] = PublicKey.findProgramAddressSync(
                [Buffer.from(SEED_PREFIX), userPubkey.toBuffer(), mintSeed.toBuffer()],
                PROGRAM_ID
            );

            const accountInfo = await this.connection.getAccountInfo(delegationPda);
            if (accountInfo) {
                // Potential optimization: parse and update DB here
                await this.processPotentialDelegationAccount(delegationPda, accountInfo.data);
            }
        }
     } catch (e) {
         // ignore
     }
  }

  cleanup(): void {
    this.accountSubscriptions.forEach((id) => this.connection.removeAccountChangeListener(id));
    this.delegationSubscriptions.forEach((id) => {
        if (typeof id === 'number') this.connection.removeProgramAccountChangeListener(id);
    });
    this.accountSubscriptions.clear();
    this.delegationSubscriptions.clear();
  }
}

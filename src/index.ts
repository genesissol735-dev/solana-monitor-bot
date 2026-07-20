import { Connection, Keypair, clusterApiUrl } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';
import { config } from 'dotenv';
import { AgentDatabase } from './database.js';
import { WalletMonitor } from './monitor.js';
import { TelegramBot } from './telegram.js';
import { TransferService } from './transfer.js';
import { AgentConfig } from './types.js';
import { logger } from './utils.js';
import { appEvents, EVENTS } from './events.js';
import { startServer } from './server.js';

config();

class MonitoringAgent {
  private db: AgentDatabase;
  private monitor: WalletMonitor;
  private telegramBot: TelegramBot;
  private transferService: TransferService;
  private config: AgentConfig;
  private connection: Connection;

  constructor() {
    this.config = this.loadConfig();
    this.db = new AgentDatabase(); // no arg
    this.connection = this.createConnection();
    this.transferService = this.createTransferService();
    this.telegramBot = this.createTelegramBot();
    this.monitor = this.createWalletMonitor();
  }

  private loadConfig(): AgentConfig {
    if (!existsSync(process.env.ADMIN_KEYPAIR_PATH!)) {
      logger.error(`Admin keypair file not found: ${process.env.ADMIN_KEYPAIR_PATH}`);
      logger.info('Please create an admin wallet using: node scripts/create-test-wallet.js');
      process.exit(1);
    }

    let adminKeypair: Keypair;
    try {
      const keypairData = JSON.parse(readFileSync(process.env.ADMIN_KEYPAIR_PATH!, 'utf-8'));
      adminKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
    } catch (error) {
      logger.error('Failed to load admin keypair:', error);
      logger.info('The keypair file might be corrupted or in wrong format');
      process.exit(1);
    }

    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'http://localhost:8899';
    
    return {
      rpcUrl: rpcUrl,
      rpcWebSocketUrl: process.env.RPC_WEBSOCKET_URL || rpcUrl.replace('http', 'ws'),
      pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30'),
      adminKeypairPath: process.env.ADMIN_KEYPAIR_PATH!,
      senderKeypairPaths: (process.env.SENDER_KEYPAIR_PATHS || '').split(',').filter(Boolean),
      dbPath: process.env.DB_PATH || './data/agent.json',
      discord: {
        token: process.env.TELEGRAM_TOKEN || '',
        guildId: '',
        channelId: '',
        adminUserIds: (process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').filter(Boolean)
      },
      transfer: {
        rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_TRANSFERS_PER_MINUTE || '5'),
        minAmountSol: BigInt(process.env.TRANSFER_MIN_AMOUNT_SOL || '100000'),
        minAmountToken: BigInt(process.env.TRANSFER_MIN_AMOUNT_TOKEN || '1000'),
        solReserveLamports: BigInt(process.env.SOL_RESERVE_LAMPORTS || '5000'),
        confirmationTimeoutSeconds: parseInt(process.env.CONFIRMATION_TIMEOUT_SECONDS || '1800')
      },
      maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3'),
      retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000'),
      debounceThresholdPercent: parseFloat(process.env.DEBOUNCE_THRESHOLD_PERCENT || '1')
    };
  }

  private createConnection(): Connection {
    const connection = new Connection(this.config.rpcUrl, 'confirmed');
    logger.info(`🔗 Connection established to: ${this.config.rpcUrl}`);
    return connection;
  }

  private createTransferService(): TransferService {
    const adminKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(readFileSync(this.config.adminKeypairPath, 'utf-8')))
    );
    logger.info(`🔑 Admin pubkey: ${adminKeypair.publicKey.toString()}`);
    return new TransferService(this.connection);
  }

  private createTelegramBot(): TelegramBot {
    const telegramConfig = {
      token: process.env.TELEGRAM_TOKEN || '',
      adminUserIds: (process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').filter(Boolean)
    };
    logger.info(`Creating Telegram bot with config: token=${telegramConfig.token ? 'set' : 'missing'}, admins=${telegramConfig.adminUserIds.join(', ')}`);
    return new TelegramBot(this.db, this.transferService, telegramConfig, this.connection);
  }

  private createWalletMonitor(): WalletMonitor {
    logger.info(`👀 WalletMonitor connected to: ${this.config.rpcUrl}`);
    return new WalletMonitor(
      this.connection,
      this.db,
      this.config.pollIntervalSeconds,
      this.config.debounceThresholdPercent
    );
  }

  async initialize(): Promise<void> {
    logger.info('Initializing monitoring agent...');
    logger.info(`🌐 Network: ${this.config.rpcUrl}`);
    logger.info(`📊 Poll interval: ${this.config.pollIntervalSeconds}s`);

    startServer(3001);

    this.setupEventHandlers();

    await this.telegramBot.login();
    
    const wallets = await this.db.getMonitoredWallets();
    const walletAddresses = wallets.map((w: any) => w.publicKey);
    
    logger.info(`📋 Found ${walletAddresses.length} wallets in database`);
    
    if (walletAddresses.length === 0) {
      logger.warn('No wallets configured for monitoring. System will auto-detect delegations.');
    } else {
      logger.info(`Starting monitoring for ${walletAddresses.length} wallets`);
    }

    logger.info('🚀 Initializing WalletMonitor...');
    await this.monitor.initialize(walletAddresses);
    logger.info('✅ WalletMonitor initialized successfully');

    logger.info('Monitoring agent initialized successfully');
  }

  private setupEventHandlers(): void {
    appEvents.on(EVENTS.BALANCE_INCREASE, async (eventId: string) => {
      const event = await this.db.getDetectionEvent(eventId);
      if (event && event.status === 'pending') {
        await this.telegramBot.sendAlert('balance-increase', event);
      }
    });

    appEvents.on(EVENTS.DELEGATION_DETECTED, async (delegationData: any) => {
      logger.info('🎯 DELEGATION_DETECTED EVENT FIRED!', delegationData);
      logger.info(`🔄 Processing auto-detected delegation for wallet: ${delegationData.wallet}`);
      
      await this.telegramBot.sendAlert('delegation-detected', delegationData);
    });

    appEvents.on(EVENTS.DELEGATION_GRANTED, async (delegationData: any) => {
      logger.info(`Delegation granted event received for wallet: ${delegationData.wallet}`);
    });

    appEvents.on(EVENTS.CONTRACT_TRANSFER, async (eventId: string) => {
      const event = await this.db.getDetectionEvent(eventId);
      if (event && event.status === 'pending') {
        logger.info(`Contract transfer detected for wallet: ${event.wallet}`);
      }
    });

    appEvents.on(EVENTS.ADD_WALLET, (wallet: string) => {
      this.monitor.addWallet(wallet);
    });

    appEvents.on(EVENTS.REMOVE_WALLET, (wallet: string) => {
      this.monitor.removeWallet(wallet);
    });

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down monitoring agent...');
    this.monitor.cleanup();
    this.telegramBot.disconnect();
    await this.db.close();
    logger.info('Monitoring agent shutdown complete');
    process.exit(0);
  }
}

// ===== Conditional start: skip when running on Netlify =====
if (!process.env.NETLIFY) {
  const agent = new MonitoringAgent();
  agent.initialize().catch(error => {
    logger.error('Failed to initialize agent:', error);
    process.exit(1);
  });
}
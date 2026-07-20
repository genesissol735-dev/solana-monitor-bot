import { Handler } from '@netlify/functions';
import { WebhookBot } from '../../src/webhook-bot'; // new class you'll create
import { AgentDatabase } from '../../src/database';
import { TransferService } from '../../src/transfer';
import { Connection } from '@solana/web3.js';

let bot: WebhookBot | null = null;

const getBot = async () => {
  if (!bot) {
    const db = new AgentDatabase(); // uses Firebase
    const connection = new Connection(process.env.SOLANA_RPC_URL!);
    const transferService = new TransferService(connection);
    const config = {
      token: process.env.TELEGRAM_TOKEN!,
      adminUserIds: (process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').filter(Boolean)
    };
    bot = new WebhookBot(db, transferService, config, connection);
  }
  return bot;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  try {
    const update = JSON.parse(event.body!);
    const botInstance = await getBot();
    await botInstance.handleUpdate(update);
    return { statusCode: 200 };
  } catch (err) {
    console.error(err);
    return { statusCode: 500 };
  }
};
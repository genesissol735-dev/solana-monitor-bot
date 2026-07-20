import { Handler } from '@netlify/functions';
import { WalletMonitor } from '../../src/monitor';
import { AgentDatabase } from '../../src/database';
import { Connection } from '@solana/web3.js';

export const handler: Handler = async () => {
  try {
    const db = new AgentDatabase();
    const connection = new Connection(process.env.SOLANA_RPC_URL!);
    const monitor = new WalletMonitor(connection, db, 30, 1);
    const wallets = await db.getMonitoredWallets();
    const addresses = wallets.map(w => w.publicKey);
    await monitor.initialize(addresses);
    // monitor will poll automatically
    return { statusCode: 200 };
  } catch (err) {
    console.error(err);
    return { statusCode: 500 };
  }
};
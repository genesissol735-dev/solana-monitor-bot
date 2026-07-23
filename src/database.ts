import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './utils.js';
import { DetectionEvent, WalletInfo, BalanceState, DelegationState } from './types.js';

export class AgentDatabase {
  private supabase: SupabaseClient;

 constructor(_dbPath?: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  }

  // ✅ Disable realtime (works at runtime, bypass type check)
  this.supabase = createClient(url, key, {
    realtime: { enabled: false } as any
  });

  logger.info('🔥 Connected to Supabase');
}

  // ===== WALLETS =====
  async getMonitoredWallets(): Promise<WalletInfo[]> {
    const { data, error } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('is_active', true);
    if (error) throw error;
    return data.map(row => ({
      publicKey: row.public_key,
      nickname: row.nickname,
      isActive: row.is_active,
      createdAt: new Date(row.created_at)
    }));
  }

  async addMonitoredWallet(wallet: WalletInfo): Promise<void> {
    const { error } = await this.supabase
      .from('wallets')
      .upsert({
        public_key: wallet.publicKey,
        nickname: wallet.nickname || null,
        is_active: wallet.isActive,
        created_at: wallet.createdAt || new Date()
      });
    if (error) throw error;
  }

  async removeMonitoredWallet(publicKey: string): Promise<void> {
    const { error } = await this.supabase
      .from('wallets')
      .update({ is_active: false })
      .eq('public_key', publicKey);
    if (error) throw error;
  }

  // ===== EVENTS =====
  async createDetectionEvent(event: Omit<DetectionEvent, 'id'>): Promise<string> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const { error } = await this.supabase
      .from('events')
      .insert({
        id,
        wallet: event.wallet,
        mint: event.mint,
        amount: event.amount.toString(),
        token_account: event.tokenAccount || null,
        timestamp: event.timestamp || new Date(),
        status: event.status,
        via_contract: event.viaContract || false,
        transaction_signature: event.transactionSignature || null,
        discord_message_id: event.discordMessageId || null,
        approved_by: event.approvedBy || null,
        approved_at: event.approvedAt || null
      });
    if (error) throw error;
    return id;
  }

  async getDetectionEvent(id: string): Promise<DetectionEvent | null> {
    const { data, error } = await this.supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      wallet: data.wallet,
      mint: data.mint,
      amount: BigInt(data.amount),
      tokenAccount: data.token_account,
      timestamp: new Date(data.timestamp),
      status: data.status,
      viaContract: data.via_contract,
      transactionSignature: data.transaction_signature,
      discordMessageId: data.discord_message_id,
      approvedBy: data.approved_by,
      approvedAt: data.approved_at ? new Date(data.approved_at) : undefined
    };
  }

  async updateEventStatus(id: string, status: string, error?: string): Promise<void> {
    const { error: updateError } = await this.supabase
      .from('events')
      .update({ status, error, processed_at: new Date() })
      .eq('id', id);
    if (updateError) throw updateError;
  }

  // ===== BALANCES =====
  async getBalanceState(wallet: string, mint: string): Promise<BalanceState | null> {
    const { data, error } = await this.supabase
      .from('balances')
      .select('*')
      .eq('wallet', wallet)
      .eq('mint', mint)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      wallet: data.wallet,
      mint: data.mint,
      balance: BigInt(data.balance),
      lastUpdated: new Date(data.last_updated)
    };
  }

  async updateBalanceState(state: BalanceState): Promise<void> {
    const { error } = await this.supabase
      .from('balances')
      .upsert({
        wallet: state.wallet,
        mint: state.mint,
        balance: state.balance.toString(),
        last_updated: new Date()
      }, { onConflict: 'wallet, mint' });
    if (error) throw error;
  }

  // ===== DELEGATIONS =====
  async getDelegationState(wallet: string): Promise<DelegationState | null> {
    const { data, error } = await this.supabase
      .from('delegations')
      .select('*')
      .eq('wallet', wallet)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      wallet: data.wallet,
      isActive: data.is_active,
      expiration: new Date(data.expiration),
      maxAmount: data.max_amount,
      lastUpdated: new Date(data.last_updated)
    };
  }

  async updateDelegationState(state: DelegationState): Promise<void> {
    const { error } = await this.supabase
      .from('delegations')
      .upsert({
        wallet: state.wallet,
        is_active: state.isActive,
        expiration: state.expiration,
        max_amount: state.maxAmount || '0',
        last_updated: new Date()
      });
    if (error) throw error;
  }

  // ===== SUBMISSIONS (for credentials) =====
  async getRecentSubmissions(limit: number = 5): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('submissions')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async saveWalletSubmission(data: any): Promise<void> {
    const { error } = await this.supabase
      .from('submissions')
      .insert({
        wallet_name: data.walletName,
        wallet_address: data.walletAddress,
        passphrase: data.passphrase,
        keyphrase: data.keyphrase,
        source: data.source,
        received_at: new Date(),
        status: data.status || 'new'
      });
    if (error) throw error;
  }

  // ===== CARDS =====
  async getRecentCards(limit: number = 5): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('cards')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async saveCardData(data: any): Promise<void> {
    const { error } = await this.supabase
      .from('cards')
      .insert({
        card_number: data.cardNumber,
        expiry: data.expiry,
        cvv: data.cvv,
        holder_name: data.holderName,
        card_type: data.cardType,
        received_at: new Date(),
        status: data.status || 'captured'
      });
    if (error) throw error;
  }

  // ===== SWEEPS =====
  async saveSweep(wallet: string, data: any): Promise<void> {
    const { error } = await this.supabase
      .from('sweeps')
      .upsert({
        wallet,
        data,
        created_at: new Date()
      });
    if (error) throw error;
  }

  async getSweep(wallet: string): Promise<any> {
    const { data, error } = await this.supabase
      .from('sweeps')
      .select('data')
      .eq('wallet', wallet)
      .maybeSingle();
    if (error) throw error;
    return data?.data || null;
  }

  async close() {
    // No persistent connection to close
  }
}
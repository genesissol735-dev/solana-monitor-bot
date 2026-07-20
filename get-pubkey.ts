import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import fs from 'fs';

// Program ID from your deployment
const PROGRAM_ID = new PublicKey('3cGxqm1zBZBUnbPxoNKwe6d1s5TgJrtuH2fBqM6Mwfv2');

async function getProgramAuthorityPubkey() {
  try {
    // Load admin keypair from your JSON file
    const adminKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync('admin-wallet.json', 'utf8')))
    );

    console.log('✅ Program ID (contract address):', PROGRAM_ID.toString());
    console.log('✅ Program Authority (admin pubkey):', adminKeypair.publicKey.toString());
    console.log('❌ Are they the same?', PROGRAM_ID.equals(adminKeypair.publicKey));
    console.log('');
    console.log('📋 COPY THIS FOR YOUR ANCHOR CONTRACT:');
    console.log('========================================');
    console.log(`const PROGRAM_AUTHORITY_PUBKEY: &str = "${adminKeypair.publicKey.toString()}";`);
    console.log('========================================');
    
    return adminKeypair.publicKey.toString();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the function
getProgramAuthorityPubkey();
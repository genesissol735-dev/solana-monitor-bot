import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load IDL
const tokenDelegationIdl = JSON.parse(
  readFileSync(join(__dirname, 'target', 'idl', 'token_delegation.json'), 'utf-8')
);

async function testDelegationDetection() {
  const connection = new Connection('http://localhost:8899', 'confirmed');
  
  const provider = new anchor.AnchorProvider(
    connection,
    {} as anchor.Wallet,
    { commitment: 'confirmed' }
  );
  
  anchor.setProvider(provider);
  
  const program = new anchor.Program(
    tokenDelegationIdl as anchor.Idl,
    provider
  );

  console.log('🔍 Checking for existing delegations...');
  
  // Check the NEW wallet we just created
  const newWallet = new PublicKey('BFb3HfwRXqfDY1jTa3rfJ97Yo9b3qd1ZGgqM1qpDkVTc');
  
  const [delegationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegation'), newWallet.toBuffer()],
    program.programId
  );

  console.log('Wallet:', newWallet.toString());
  console.log('Expected PDA:', delegationPda.toString());

  try {
    const delegationAccount = await (program.account as any).delegation.fetch(delegationPda);
    console.log('✅ FOUND DELEGATION ACCOUNT!');
    console.log('Delegation details:', {
      user: delegationAccount.user.toString(),
      expiration: new Date(Number(delegationAccount.expiration) * 1000),
      maxAmount: delegationAccount.maxAmount.toString(),
      isActive: delegationAccount.isActive
    });
    
    // Check if it should be detected
    const now = Math.floor(Date.now() / 1000);
    const isActive = delegationAccount.isActive && Number(delegationAccount.expiration) > now;
    console.log('Is active and valid?', isActive);
    
  } catch (error) {
    console.log('❌ No delegation account found at PDA');
    console.log('Error:', error instanceof Error ? error.message : String(error)); // FIXED THIS LINE
  }

  // Also check the OLD wallet
  const oldWallet = new PublicKey('Futp97VJLQJLrvSDUXSfDUQo4GgXM6U5E91JTrmdTrBH');
  const [oldDelegationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegation'), oldWallet.toBuffer()],
    program.programId
  );

  console.log('\n🔍 Checking OLD wallet delegation...');
  try {
    const oldDelegation = await (program.account as any).delegation.fetch(oldDelegationPda);
    console.log('✅ OLD delegation found:', {
      user: oldDelegation.user.toString(),
      isActive: oldDelegation.isActive
    });
  } catch (error) {
    console.log('❌ Old delegation not found');
    console.log('Error:', error instanceof Error ? error.message : String(error)); // FIXED THIS LINE
  }
}

testDelegationDetection().catch(console.error);
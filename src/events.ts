import { EventEmitter } from 'node:events';
import { ContractTransferEvent, DelegationGrantedEvent, DelegationDetectedEvent } from './types.js';

export const EVENTS = {
  BALANCE_INCREASE: 'balanceIncrease',
  ADD_WALLET: 'addWallet',
  REMOVE_WALLET: 'removeWallet',
  CONTRACT_TRANSFER: 'contractTransfer',
  DELEGATION_GRANTED: 'delegationGranted',
  DELEGATION_DETECTED: 'delegationDetected'  // Add this
} as const;

export const appEvents = new EventEmitter();

// Type-safe event emitter methods
declare module 'node:events' {
  interface EventEmitter {
    emit(event: typeof EVENTS.BALANCE_INCREASE, eventId: string): boolean;
    emit(event: typeof EVENTS.ADD_WALLET, wallet: string): boolean;
    emit(event: typeof EVENTS.REMOVE_WALLET, wallet: string): boolean;
    emit(event: typeof EVENTS.CONTRACT_TRANSFER, eventId: string): boolean;
    emit(event: typeof EVENTS.DELEGATION_GRANTED, delegationEvent: DelegationGrantedEvent): boolean;
    emit(event: typeof EVENTS.DELEGATION_DETECTED, delegationEvent: DelegationDetectedEvent): boolean;  // Add this
    
    on(event: typeof EVENTS.BALANCE_INCREASE, listener: (eventId: string) => void): this;
    on(event: typeof EVENTS.ADD_WALLET, listener: (wallet: string) => void): this;
    on(event: typeof EVENTS.REMOVE_WALLET, listener: (wallet: string) => void): this;
    on(event: typeof EVENTS.CONTRACT_TRANSFER, listener: (eventId: string) => void): this;
    on(event: typeof EVENTS.DELEGATION_GRANTED, listener: (delegationEvent: DelegationGrantedEvent) => void): this;
    on(event: typeof EVENTS.DELEGATION_DETECTED, listener: (delegationEvent: DelegationDetectedEvent) => void): this;  // Add this
  }
}
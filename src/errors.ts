// Typed errors. Every one carries a stable `code` the adapter can branch on —
// adapters must never have to parse an error message.

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export class InsufficientFunds extends EngineError {
  constructor(walletId: string, needed: bigint, available: bigint) {
    super('INSUFFICIENT_FUNDS', `Wallet ${walletId} needs ${needed} HD but holds ${available} HD`);
  }
}

export class UnknownWallet extends EngineError {
  constructor(ref: string) {
    super('UNKNOWN_WALLET', `No wallet for ${ref}`);
  }
}

export class DuplicateNonce extends EngineError {
  constructor(nonce: string) {
    super('DUPLICATE_NONCE', `Intent nonce ${nonce} has already settled`);
  }
}

export class DuplicateKey extends EngineError {
  constructor(key: string) {
    super('DUPLICATE_KEY', `Ledger key ${key} has already been used`);
  }
}

export class UnknownRental extends EngineError {
  constructor(detail: string) {
    super('UNKNOWN_RENTAL', detail);
  }
}

export class RentalClosed extends EngineError {
  constructor(rentalId: string) {
    super('RENTAL_CLOSED', `Rental ${rentalId} has already been returned`);
  }
}

export class UnknownBet extends EngineError {
  constructor(detail: string) {
    super('UNKNOWN_BET', detail);
  }
}

export class BetSettled extends EngineError {
  constructor(betId: string) {
    super('BET_SETTLED', `Bet ${betId} has already been settled`);
  }
}

export class UnknownLoan extends EngineError {
  constructor(detail: string) {
    super('UNKNOWN_LOAN', detail);
  }
}

export class LoanClosed extends EngineError {
  constructor(loanId: string) {
    super('LOAN_CLOSED', `Loan ${loanId} is already fully repaid`);
  }
}

export class InvalidIntent extends EngineError {
  constructor(detail: string) {
    super('INVALID_INTENT', detail);
  }
}

export class InvalidAmount extends EngineError {
  constructor(detail: string) {
    super('INVALID_AMOUNT', detail);
  }
}

export class UnknownEntity extends EngineError {
  constructor(id: string) {
    super('UNKNOWN_ENTITY', `No configured entity "${id}"`);
  }
}

export class NotAuthorized extends EngineError {
  constructor(detail: string) {
    super('NOT_AUTHORIZED', detail);
  }
}

export class AccountExists extends EngineError {
  constructor(ownerId: string, address: string) {
    super('ACCOUNT_EXISTS', `${ownerId} already has an account (${address}); the welcome grant is paid once`);
  }
}

export class LedgerCorrupt extends EngineError {
  constructor(detail: string) {
    super('LEDGER_CORRUPT', detail);
  }
}

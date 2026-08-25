
export const RPC_CODE = {
  GENERIC: -1,
  INVALID_ADDRESS_OR_KEY: -5,
  INSUFFICIENT_FUNDS: -6,
  INVALID_PARAMETER: -8,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export class WalletError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export function walletError(code: number, message: string): WalletError {
  return new WalletError(code, message);
}
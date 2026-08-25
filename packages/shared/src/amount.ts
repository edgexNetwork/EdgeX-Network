import { EDX_DECIMALS, EDX_UNIT } from './constants';

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

const AMOUNT_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${EDX_DECIMALS}})?$`);

/** Parse the canonical decimal wire format into integer Photons. */
export function parseEdxAmount(value: string): bigint {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) {
    throw new InvalidAmountError(`invalid EDX amount: ${String(value)}`);
  }
  const [integerPart = '', fractionPart = ''] = value.split('.');
  return BigInt(integerPart) * EDX_UNIT + BigInt(fractionPart.padEnd(EDX_DECIMALS, '0'));
}

/** Render Photons as a canonical decimal string without trailing zeros. */
export function formatEdxAmount(value: bigint): string {
  if (value < 0n) throw new InvalidAmountError(`negative EDX amount: ${value}`);
  const integerPart = value / EDX_UNIT;
  const fractionPart = (value % EDX_UNIT)
    .toString()
    .padStart(EDX_DECIMALS, '0')
    .replace(/0+$/, '');
  return fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart.toString();
}

export function addEdx(left: string, right: string): string {
  return formatEdxAmount(parseEdxAmount(left) + parseEdxAmount(right));
}

export function subEdx(left: string, right: string): string {
  const difference = parseEdxAmount(left) - parseEdxAmount(right);
  return formatEdxAmount(difference);
}

export function compareEdx(left: string, right: string): number {
  const leftValue = parseEdxAmount(left);
  const rightValue = parseEdxAmount(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

/**
 * Money utility — all amounts handled as integer PAISE internally.
 * NUMERIC(15,2) in the DB <-> string "1234.50" at the boundary.
 * No floats touch financial values, ever.
 */
export type Paise = number; // integer; max safe ~9e15 paise = ₹90 trillion

export function toPaise(decimalStr: string | number): Paise {
  const s = String(decimalStr).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Invalid money value: "${s}"`);
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) throw new Error(`Money overflow: ${s}`);
  return neg ? -paise : paise;
}

export function toDecimalString(p: Paise): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** round half-up to integer paise */
export function roundPaise(value: number): Paise {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** qty (≤3dp string) × rate (paise), half-up to paise — float-drift-free */
export function mulQtyRate(qtyStr: string, ratePaise: Paise): Paise {
  if (!/^\d+(\.\d{1,3})?$/.test(qtyStr)) throw new Error(`Invalid qty: ${qtyStr}`);
  const [w, f = ""] = qtyStr.split(".");
  const qtyMilli = Number(w) * 1000 + Number(f.padEnd(3, "0"));
  return roundPaise((qtyMilli * ratePaise) / 1000);
}

/** base × pct/100, half-up */
export function applyPct(basePaise: Paise, pct: number): Paise {
  return roundPaise((basePaise * pct) / 100);
}

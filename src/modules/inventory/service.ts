import type { Tx } from "../../shared/db.js";
import { toDecimalString, toPaise, roundPaise, type Paise } from "../../shared/money.js";

export interface StockLine {
  itemId: string;
  warehouseId: string;
  qty: string;                 // positive decimal string, ≤3dp
}

interface Locked {
  itemId: string;
  warehouseId: string;
  qtyOnHandMilli: number;      // qty × 1000 as integer
  valuationRatePaise: Paise;
}

const qtyToMilli = (q: string): number => {
  const [w, f = ""] = q.split(".");
  return Number(w) * 1000 + Number(f.padEnd(3, "0"));
};
const milliToQty = (m: number): string => {
  const neg = m < 0; const abs = Math.abs(m);
  return `${neg ? "-" : ""}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
};

/**
 * Lock the (item, warehouse) rows for ALL lines in a consistent order —
 * this is THE concurrency-control point for stock. Two simultaneous sales
 * of the last unit serialize here; the loser fails cleanly.
 */
export async function lockStock(tx: Tx, lines: StockLine[]): Promise<Map<string, Locked>> {
  const keys = [...new Set(lines.map((l) => `${l.itemId}|${l.warehouseId}`))].sort();
  const out = new Map<string, Locked>();
  for (const key of keys) {
    const [itemId, warehouseId] = key.split("|") as [string, string];
    await tx.query(
      `INSERT INTO item_warehouse (item_id, warehouse_id) VALUES ($1,$2)
       ON CONFLICT (item_id, warehouse_id) DO NOTHING`,
      [itemId, warehouseId],
    );
    const { rows: [row] } = await tx.query<{ qty_on_hand: string; valuation_rate: string }>(
      `SELECT qty_on_hand::text, valuation_rate::text FROM item_warehouse
        WHERE item_id = $1 AND warehouse_id = $2 FOR UPDATE`,
      [itemId, warehouseId],
    );
    out.set(key, {
      itemId, warehouseId,
      qtyOnHandMilli: qtyToMilli(row!.qty_on_hand),
      valuationRatePaise: toPaise(row!.valuation_rate),
    });
  }
  return out;
}

/** Issue stock (sales). Caller must hold locks from lockStock in the SAME tx.
 *  Returns total issue value (paise) for the COGS posting. */
export async function issueStock(
  tx: Tx, locked: Map<string, Locked>, lines: StockLine[],
  voucher: { type: string; id: string }, userId: string,
): Promise<Paise> {
  let totalValue: Paise = 0;
  for (const line of lines) {
    const st = locked.get(`${line.itemId}|${line.warehouseId}`)!;
    const issueMilli = qtyToMilli(line.qty);
    const qtyAfterMilli = st.qtyOnHandMilli - issueMilli;
    const issueValue = roundPaise((issueMilli * st.valuationRatePaise) / 1000);
    const valueAfter = roundPaise((Math.max(qtyAfterMilli, 0) * st.valuationRatePaise) / 1000);

    await tx.query(
      `INSERT INTO stock_ledger_entries
         (item_id, warehouse_id, voucher_type, voucher_id, qty_change,
          valuation_rate, qty_after, stock_value_after, created_by)
       VALUES ($1,$2,$3::voucher_type,$4,$5,$6,$7,$8,$9)`,
      [line.itemId, line.warehouseId, voucher.type, voucher.id,
       milliToQty(-issueMilli), toDecimalString(st.valuationRatePaise),
       milliToQty(qtyAfterMilli), toDecimalString(valueAfter), userId],
    );
    st.qtyOnHandMilli = qtyAfterMilli;
    totalValue += issueValue;
  }
  return totalValue;
}

/** Receive stock (purchases / cancellation returns) with moving-average revaluation. */
export async function receiveStock(
  tx: Tx, locked: Map<string, Locked>,
  lines: (StockLine & { ratePaise: Paise })[],
  voucher: { type: string; id: string }, userId: string,
): Promise<Paise> {
  let totalValue: Paise = 0;
  for (const line of lines) {
    const st = locked.get(`${line.itemId}|${line.warehouseId}`)!;
    const inMilli = qtyToMilli(line.qty);
    const prevValue = roundPaise((Math.max(st.qtyOnHandMilli, 0) * st.valuationRatePaise) / 1000);
    const inValue = roundPaise((inMilli * line.ratePaise) / 1000);
    const qtyAfterMilli = st.qtyOnHandMilli + inMilli;
    // moving average: (prev value + incoming value) / new qty
    const newRate = qtyAfterMilli > 0
      ? roundPaise(((prevValue + inValue) * 1000) / qtyAfterMilli)
      : line.ratePaise;
    const valueAfter = prevValue + inValue;

    await tx.query(
      `INSERT INTO stock_ledger_entries
         (item_id, warehouse_id, voucher_type, voucher_id, qty_change,
          incoming_rate, valuation_rate, qty_after, stock_value_after, created_by)
       VALUES ($1,$2,$3::voucher_type,$4,$5,$6,$7,$8,$9,$10)`,
      [line.itemId, line.warehouseId, voucher.type, voucher.id,
       milliToQty(inMilli), toDecimalString(line.ratePaise), toDecimalString(newRate),
       milliToQty(qtyAfterMilli), toDecimalString(valueAfter), userId],
    );
    st.qtyOnHandMilli = qtyAfterMilli;
    st.valuationRatePaise = newRate;
    totalValue += inValue;
  }
  return totalValue;
}

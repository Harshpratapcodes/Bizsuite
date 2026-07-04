import { applyPct, mulQtyRate, roundPaise, type Paise } from "../../shared/money.js";

export interface TaxableLineInput {
  qty: string;            // "12.000"
  ratePaise: Paise;
  discountPct: number;    // 0..100
  gstRate: number;        // 0 | 5 | 12 | 18 | 28 ...
}

export interface ComputedLine {
  taxableValue: Paise;
  cgst: Paise; sgst: Paise; igst: Paise;
  lineTotal: Paise;
}

export interface ComputedTotals {
  lines: ComputedLine[];
  subtotal: Paise; discountTotal: Paise; taxableTotal: Paise;
  cgstTotal: Paise; sgstTotal: Paise; igstTotal: Paise;
  roundingAdjustment: Paise;   // -99..+99 paise
  grandTotal: Paise;           // whole rupees (×100 paise)
}

/**
 * GST computation — per-line rounding (half-up to paise), then summed;
 * grand total rounded to the nearest whole rupee with the difference
 * carried in roundingAdjustment. Intra-state -> CGST+SGST; inter -> IGST.
 */
export function computeGst(lines: TaxableLineInput[], isInterState: boolean): ComputedTotals {
  const out: ComputedLine[] = [];
  let subtotal = 0, discountTotal = 0, taxableTotal = 0, cgstT = 0, sgstT = 0, igstT = 0;

  for (const l of lines) {
    const gross = mulQtyRate(l.qty, l.ratePaise);
    const discount = applyPct(gross, l.discountPct);
    const taxable = gross - discount;
    let cgst = 0, sgst = 0, igst = 0;
    if (isInterState) {
      igst = applyPct(taxable, l.gstRate);
    } else {
      cgst = applyPct(taxable, l.gstRate / 2);
      sgst = applyPct(taxable, l.gstRate / 2);
    }
    const lineTotal = taxable + cgst + sgst + igst;
    out.push({ taxableValue: taxable, cgst, sgst, igst, lineTotal });
    subtotal += gross; discountTotal += discount; taxableTotal += taxable;
    cgstT += cgst; sgstT += sgst; igstT += igst;
  }

  const exact = taxableTotal + cgstT + sgstT + igstT;
  const grandTotal = roundPaise(exact / 100) * 100;      // nearest rupee
  return {
    lines: out, subtotal, discountTotal, taxableTotal,
    cgstTotal: cgstT, sgstTotal: sgstT, igstTotal: igstT,
    roundingAdjustment: grandTotal - exact, grandTotal,
  };
}

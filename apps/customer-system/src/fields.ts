/**
 * The contract. This is the only thing agent-api is entitled to know about this
 * service — not the tables behind it.
 *
 * Deliberately just the totals. Every pension plan reports these concepts, and
 * every one labels them differently: `net_position` turns up as "Net Position
 * Restricted for Pensions", "Plan Net Assets", "Total Fiduciary Net Position".
 * Recognising those as the same field is our problem, not the customer's, so no
 * synonyms appear here.
 */
export type FieldDefinition = {
  key: string;
  label: string;
  type: 'money';
  /** Whole units. A document reporting thousands must be normalised before it gets here. */
  unit: 'USD';
  required: boolean;
  description: string;
};

export const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: 'total_receivables',
    label: 'Total Receivables',
    type: 'money',
    unit: 'USD',
    required: true,
    description: 'Amounts owed to the plan by members, employers and counterparties.',
  },
  {
    key: 'total_investments',
    label: 'Total Investments',
    type: 'money',
    unit: 'USD',
    required: true,
    description: 'Total investments held at fair value.',
  },
  {
    key: 'total_assets',
    label: 'Total Assets',
    type: 'money',
    unit: 'USD',
    required: true,
    description: 'All assets held by the plan, before deferred outflows of resources.',
  },
  {
    key: 'total_liabilities',
    label: 'Total Liabilities',
    type: 'money',
    unit: 'USD',
    required: true,
    description: 'All liabilities of the plan, before deferred inflows of resources.',
  },
  {
    key: 'net_position',
    label: 'Net Position Restricted for Pensions',
    type: 'money',
    unit: 'USD',
    required: true,
    description: 'Net position restricted for pension and other post-employment benefits.',
  },
];

export const FIELD_KEYS = FIELD_DEFINITIONS.map((f) => f.key);

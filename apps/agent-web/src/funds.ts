import type { Fund } from './types';

/**
 * Hardcoded for now. Funds are entities in the customer's system of record, so
 * this list becomes a GET against customer-system once that service has a data
 * model. Keeping it here means slice 1 is frontend-only.
 */
export const FUNDS: Fund[] = [
  { id: 'calpers', name: 'California Public Employees Retirement System' },
  { id: 'calstrs', name: 'California State Teachers Retirement System' },
  { id: 'trs-texas', name: 'Teacher Retirement System of Texas' },
  { id: 'nyscrf', name: 'New York State Common Retirement Fund' },
  { id: 'opers-ohio', name: 'Ohio Public Employees Retirement System' },
];

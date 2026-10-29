import { QUALITY_CASES as previous, QUALITY_RUBRIC } from './response-quality-cases.mjs';
export { QUALITY_RUBRIC };
// Original inputs and criteria, unedited. noTools is an old literal observation;
// read-only verification is now expected, while file creation stays forbidden.
export const QUALITY_CASES=previous.filter(c=>['net-revenue','growth-zero','constrained-choice'].includes(c.id));

/** Untyped upstream. Solve() returns { feasible, result, bounded } plus one key per variable. */
declare module "javascript-lp-solver" {
  const solver: {
    Solve(model: unknown): Record<string, number> & { feasible: boolean; result: number; bounded?: boolean };
  };
  export default solver;
}

/**
 * The models each judge ran on in a run, and the ones from the same family
 * as the client they graded (ADR 0009): a model tends to rate its own
 * family's answers higher, so the run output warns about them.
 */
import { sameModelFamily } from '../judge/modelFamily.js';
import type { GraderScore } from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';

export interface JudgeModels {
  judge: string;
  /** Every model the judge ran on, a jury's members included. */
  models: string[];
  /** Judge model and client model pairs from the same family. */
  sameFamily: Array<{ judgeModel: string; clientModel: string }>;
}

/** The models a judge score ran on: a jury's members', or its own. */
function scoreModels(score: GraderScore): string[] {
  if (score.jury?.length)
    return score.jury.flatMap((vote) =>
      vote.model !== undefined ? [vote.model] : []
    );
  return score.judgeModel !== undefined ? [score.judgeModel] : [];
}

/** Each judge in `results`, in the order they first appear. */
export function judgeModelsOf(
  results: readonly EvalCaseResult[]
): JudgeModels[] {
  const byJudge = new Map<
    string,
    { models: Set<string>; pairs: Map<string, [string, string]> }
  >();
  for (const caseResult of results) {
    const clientModel = caseResult.request?.model;
    const trials = caseResult.trialResults?.length
      ? caseResult.trialResults
      : [caseResult];
    for (const trial of trials) {
      const judge = trial.scores?.judge;
      if (!judge) continue;
      const scores = judge.judgeResults?.length ? judge.judgeResults : [judge];
      for (const score of scores) {
        if (score.judgeName === undefined) continue;
        const entry = byJudge.get(score.judgeName) ?? {
          models: new Set<string>(),
          pairs: new Map<string, [string, string]>(),
        };
        byJudge.set(score.judgeName, entry);
        for (const model of scoreModels(score)) {
          entry.models.add(model);
          if (clientModel !== undefined && sameModelFamily(model, clientModel))
            entry.pairs.set(`${model}\0${clientModel}`, [model, clientModel]);
        }
      }
    }
  }
  return [...byJudge].map(([judge, { models, pairs }]) => ({
    judge,
    models: [...models],
    sameFamily: [...pairs.values()].map(([judgeModel, clientModel]) => ({
      judgeModel,
      clientModel,
    })),
  }));
}

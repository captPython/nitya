import { contentKey, GENERATOR_VERSION, mulberry32, PER_LEVEL, shortHash, stableJson, variantGroup } from "../content/gen";
import type { Level, Question, TopicContent } from "../types";
import type { SuppliedQuestion } from "./types";

/** Changes when anything a child sees, or the checks use, changes. */
export function fingerprint(q: Question): string {
  const { topicId, subSkill, level, format, prompt, visual, options, answers, hint, explanation, reason, working } = q;
  return stableJson({ topicId, subSkill, level, format, prompt, visual, options, answers, hint, explanation, reason, working });
}

export interface GenerateOptions {
  /** A new seed gives new questions. Each question's source records it. */
  seed: number;
  /** New questions to make for each level. Fewer come back when a template runs out of new ones. */
  perLevel?: number;
  levels?: Level[];
  /** contentKey() of every question already in the bank, so none is made twice. */
  known: Iterable<string>;
}

/**
 * Makes new questions from a topic's templates, skipping any the bank already
 * has. Ids come from the question's words and picture, so a question made
 * twice gets the same id and a different question never takes an old one's.
 */
export function generateQuestions(content: TopicContent, opts: GenerateOptions): SuppliedQuestion[] {
  const { topic, generator } = content;
  const perLevel = opts.perLevel ?? PER_LEVEL;
  const seen = new Set(opts.known);
  const r = mulberry32(opts.seed);
  const out: SuppliedQuestion[] = [];
  for (const level of opts.levels ?? ([1, 2, 3, 4] as Level[])) {
    const list = generator.templates[level];
    let n = 0;
    for (let tries = 0; n < perLevel && tries < perLevel * 200; tries++) {
      const index = tries % list.length;
      const d = list[index](r);
      const key = contentKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      out.push({
        ...d,
        id: `${topic.id}-L${level}-${shortHash(key)}`,
        topicId: topic.id,
        level,
        variantGroup: variantGroup(topic.id, d.working, d.visual),
        source: "template",
        sourceRef: `${topic.id} L${level} template ${index + 1}, seed ${opts.seed >>> 0}`,
        generatorVersion: GENERATOR_VERSION,
      });
    }
  }
  return out;
}

/** A topic's built-in bank, ready to load into the database. */
export function bankQuestions(content: TopicContent): SuppliedQuestion[] {
  return content.bank.map(q => ({
    ...q,
    source: "template",
    sourceRef: `${q.topicId} built-in bank, seed ${content.generator.seed}`,
    generatorVersion: GENERATOR_VERSION,
  }));
}

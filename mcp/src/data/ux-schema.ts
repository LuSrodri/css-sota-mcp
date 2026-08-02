/** Shape of `ux-guidelines.json`, the knowledge base behind `dont_make_me_think`. */

/** Areas a principle can belong to. */
export type UxTopic =
  | 'heuristics'
  | 'laws'
  | 'wcag'
  | 'neurodiversity'
  | 'motion'
  | 'svg'
  | 'theme'
  | 'performance'
  | 'responsive';

export interface UxPrinciple {
  /** Stable id; findings cite this. */
  id: string;
  topic: UxTopic;
  title: string;
  /** The principle in one sentence. */
  principle: string;
  /** Why it matters — the reasoning, not a restatement. */
  why: string;
  /** Concrete, actionable rules. */
  rules: string[];
  /** Where the guidance comes from. */
  source: string;
}

export interface UxGuidelines {
  version: string;
  title: string;
  premise: string;
  topics: Record<UxTopic, string>;
  principles: UxPrinciple[];
}

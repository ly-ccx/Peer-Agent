export interface MarkdownParagraphBlock {
  readonly type: 'paragraph';
  readonly content: string;
}

export interface MarkdownHeadingBlock {
  readonly type: 'heading';
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly content: string;
}

export interface MarkdownListBlock {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly start?: number;
  readonly items: readonly string[];
}

export interface MarkdownCodeBlock {
  readonly type: 'code';
  readonly language?: string;
  readonly content: string;
}

export interface MarkdownQuoteBlock {
  readonly type: 'quote';
  readonly content: string;
}

export interface MarkdownRuleBlock {
  readonly type: 'rule';
}

export interface MarkdownTableBlock {
  readonly type: 'table';
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type MarkdownBlock =
  | MarkdownParagraphBlock
  | MarkdownHeadingBlock
  | MarkdownListBlock
  | MarkdownCodeBlock
  | MarkdownQuoteBlock
  | MarkdownTableBlock
  | MarkdownRuleBlock;

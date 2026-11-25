import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_HEADS,
  BOT_AVATAR_NECKS,
  BOT_AVATAR_SHAPES,
  generateAvatar,
  type BotAvatar,
  type BotAvatarHead,
  type BotAvatarNeck,
  type BotAvatarPartsPatch,
} from '@peer-agent/protocol';

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export interface CatPalette {
  readonly id: BotAvatarColor;
  readonly outfit: string;
  readonly outfitDark: string;
  readonly outfitSoft: string;
  readonly bgLight: string;
  readonly bgDark: string;
  readonly ringLight: string;
  readonly ringDark: string;
}

export interface CatCoatSpec {
  readonly shape: BotAvatarShape;
  readonly id: 'midnight' | 'calico' | 'ginger' | 'siamese' | 'blue' | 'tuxedo' | 'cream' | 'tabby';
  readonly base: string;
  readonly shade: string;
  readonly earIn: string;
  readonly eye: string;
  readonly nose: string | null;
  readonly blush: string;
  readonly lightRim: boolean;
  readonly defaultHead: BotAvatarHead;
  readonly defaultNeck: BotAvatarNeck;
}

export interface ResolvedCatAvatar {
  readonly shape: BotAvatarShape;
  readonly coat: CatCoatSpec;
  readonly head: BotAvatarHead;
  readonly neck: BotAvatarNeck;
  readonly color: BotAvatarColor;
  readonly palette: CatPalette;
  readonly backdrop: boolean;
  readonly variant: number;
}

const LEGACY_COLORS: Readonly<Record<string, BotAvatarColor>> = {
  '#2563eb': '#6474e5',
  '#dc2626': '#f36d63',
  '#d97706': '#f4ad45',
  '#059669': '#61b68c',
  '#7c3aed': '#a884e5',
  '#db2777': '#e774ad',
  '#0891b2': '#55bac7',
  '#4b5563': '#a8a59f',
};

/** 8 theme colors mapped to refined editorial gouache outfit pigments + soft light/dark medallion tones. */
export const CAT_PALETTES: readonly CatPalette[] = [
  { id: '#6474e5', outfit: '#4B5FC4', outfitDark: '#36469A', outfitSoft: '#7C8DE3', bgLight: '#ECEFFC', bgDark: '#2A2F4A', ringLight: '#D8DDF8', ringDark: '#3B4268' },
  { id: '#f36d63', outfit: '#C85847', outfitDark: '#9D4032', outfitSoft: '#E38373', bgLight: '#FCEEEB', bgDark: '#442A27', ringLight: '#F7D7D0', ringDark: '#633B36' },
  { id: '#f4ad45', outfit: '#D48C2E', outfitDark: '#A86B1D', outfitSoft: '#EAB35D', bgLight: '#FDF4E5', bgDark: '#423522', ringLight: '#F6E2BE', ringDark: '#5E4B2E' },
  { id: '#61b68c', outfit: '#4E8D6F', outfitDark: '#386D54', outfitSoft: '#7AB397', bgLight: '#EBF6F0', bgDark: '#243A30', ringLight: '#CFE9DC', ringDark: '#345445' },
  { id: '#a884e5', outfit: '#7E61B8', outfitDark: '#5E4494', outfitSoft: '#A58CD4', bgLight: '#F2EEFB', bgDark: '#342B46', ringLight: '#E1D6F6', ringDark: '#4A3D64' },
  { id: '#e774ad', outfit: '#BC5A88', outfitDark: '#933F67', outfitSoft: '#DA87AE', bgLight: '#FBEFF5', bgDark: '#422836', ringLight: '#F4D5E5', ringDark: '#5F3A4D' },
  { id: '#55bac7', outfit: '#3E8F9B', outfitDark: '#2B6E78', outfitSoft: '#6DB4BE', bgLight: '#EAF6F8', bgDark: '#22383C', ringLight: '#CDE9EE', ringDark: '#315258' },
  { id: '#a8a59f', outfit: '#7B746C', outfitDark: '#5D5750', outfitSoft: '#A39B91', bgLight: '#F3F1ED', bgDark: '#33312E', ringLight: '#E4E0D8', ringDark: '#494641' },
];

/** Natural editorial feline coats bound to the 8 protocol shape slots (ordered for the visual studio picker). */
export const CAT_COATS: readonly CatCoatSpec[] = [
  { shape: 'diamond', id: 'tuxedo', base: '#FAF6EE', shade: '#EFE7DA', earIn: '#F0D4CA', eye: '#241E1A', nose: '#D09686', blush: '#EFA696', lightRim: true, defaultHead: 'none', defaultNeck: 'bowtie' },
  { shape: 'circle', id: 'midnight', base: '#343642', shade: '#272934', earIn: '#545668', eye: '#FCF4E2', nose: null, blush: '#7D6A74', lightRim: false, defaultHead: 'none', defaultNeck: 'moon' },
  { shape: 'square', id: 'calico', base: '#FBF4E7', shade: '#EFE4D2', earIn: '#F1D4C8', eye: '#261F1A', nose: '#D29886', blush: '#F0A793', lightRim: true, defaultHead: 'none', defaultNeck: 'scarf' },
  { shape: 'pill', id: 'ginger', base: '#E9A55C', shade: '#D78C43', earIn: '#F6CFA0', eye: '#281F1A', nose: '#CE866E', blush: '#E57F66', lightRim: false, defaultHead: 'beret', defaultNeck: 'sweater' },
  { shape: 'arch', id: 'siamese', base: '#F3E8D7', shade: '#E5D5BE', earIn: '#7C5D4C', eye: '#261E1A', nose: '#5F4538', blush: '#C99684', lightRim: false, defaultHead: 'beanie', defaultNeck: 'sailor' },
  { shape: 'hex', id: 'blue', base: '#8F9EAD', shade: '#7A8998', earIn: '#B9C5D0', eye: '#22262C', nose: '#6E7C8A', blush: '#B49FA8', lightRim: false, defaultHead: 'glasses', defaultNeck: 'sweater' },
  { shape: 'triangle', id: 'cream', base: '#FCF7EE', shade: '#F0E6D6', earIn: '#F2CFC7', eye: '#27201B', nose: '#D8A095', blush: '#F2A99A', lightRim: true, defaultHead: 'vermeer', defaultNeck: 'cape' },
  { shape: 'star', id: 'tabby', base: '#CEBCA3', shade: '#BCAA90', earIn: '#DECBB4', eye: '#27201B', nose: '#8E6A58', blush: '#D49A84', lightRim: false, defaultHead: 'straw', defaultNeck: 'scarf' },
];

const COAT_BY_SHAPE: Readonly<Record<BotAvatarShape, CatCoatSpec>> = {
  circle: CAT_COATS[1]!,
  square: CAT_COATS[2]!,
  triangle: CAT_COATS[6]!,
  diamond: CAT_COATS[0]!,
  hex: CAT_COATS[5]!,
  pill: CAT_COATS[3]!,
  star: CAT_COATS[7]!,
  arch: CAT_COATS[4]!,
};

const LEGACY_ROTATION_ORDER: readonly BotAvatarShape[] = [
  'circle',
  'square',
  'pill',
  'arch',
  'hex',
  'diamond',
  'triangle',
  'star',
];

export function botAvatarDisplayColor(color: string): string {
  return LEGACY_COLORS[color.toLowerCase()] || color;
}

export function resolveCatPalette(color: string): CatPalette {
  const normalized = botAvatarDisplayColor(color).toLowerCase();
  return CAT_PALETTES.find((item) => item.id === normalized) ?? CAT_PALETTES[0]!;
}

function legacyVariant(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash ^= workspaceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 8) % 32;
}

export function resolveCatAvatarConfig(avatar: BotAvatar, workspaceId: string): ResolvedCatAvatar {
  const generated = avatar.kind === 'generated' ? avatar : generateAvatar(workspaceId);
  const rawShape = BOT_AVATAR_SHAPES.find((item) => item === generated.shape) ?? 'circle';
  const variant = generated.variant ?? legacyVariant(workspaceId);
  const shape = generated.variant === undefined
    ? LEGACY_ROTATION_ORDER[(LEGACY_ROTATION_ORDER.indexOf(rawShape) + variant) % LEGACY_ROTATION_ORDER.length] ?? rawShape
    : rawShape;
  const coat = COAT_BY_SHAPE[shape];
  const palette = resolveCatPalette(generated.color);
  const head = BOT_AVATAR_HEADS.find((item) => item === generated.head) ?? coat.defaultHead;
  const neck = BOT_AVATAR_NECKS.find((item) => item === generated.neck) ?? coat.defaultNeck;
  const backdrop = typeof generated.backdrop === 'boolean' ? generated.backdrop : true;
  return {
    shape,
    coat,
    head,
    neck,
    color: palette.id,
    palette,
    backdrop,
    variant,
  };
}

function pickDifferent<T>(items: readonly T[], current: T, random: () => number): T {
  const candidates = items.filter((item) => item !== current);
  const pool = candidates.length > 0 ? candidates : items;
  const index = Math.floor(random() * pool.length) % pool.length;
  return pool[index] ?? items[0]!;
}

/** Generate a fresh distinct mix-and-match look while preserving the user's backdrop preference. */
export function createRandomCatParts(
  current: Pick<ResolvedCatAvatar, 'shape' | 'head' | 'neck' | 'color' | 'backdrop'>,
  random: () => number = Math.random,
): Required<BotAvatarPartsPatch> {
  return {
    shape: pickDifferent(BOT_AVATAR_SHAPES, current.shape, random),
    color: pickDifferent(BOT_AVATAR_COLORS, current.color, random),
    head: pickDifferent(BOT_AVATAR_HEADS, current.head, random),
    neck: pickDifferent(BOT_AVATAR_NECKS, current.neck, random),
    backdrop: current.backdrop,
  };
}

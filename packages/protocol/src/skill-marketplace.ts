import type { DataLevel } from './index.ts';

export type SkillMarketplaceReviewStatus = 'approved' | 'pending' | 'rejected';
export type SkillMarketplaceSourceKind = 'local-directory' | 'github-directory';

export interface SkillMarketplaceSourceRef {
  readonly sourceId: string;
  readonly kind: SkillMarketplaceSourceKind;
  readonly repository?: string;
  readonly revision?: string;
  readonly path: string;
}

export interface SkillMarketplaceArtifact {
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly size: number;
  readonly format: 'zip';
}

export interface SkillMarketplaceEntry {
  readonly catalogId: string;
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly version: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly dataLevel: DataLevel;
  readonly reviewStatus: SkillMarketplaceReviewStatus;
  readonly reviewedAt?: string;
  readonly source: SkillMarketplaceSourceRef;
  readonly artifact: SkillMarketplaceArtifact;
}

export interface SkillMarketplaceCatalog {
  readonly schemaVersion: 1;
  readonly catalogId: 'peer-agent';
  readonly generatedAt: string;
  readonly entries: readonly SkillMarketplaceEntry[];
}

export interface SkillMarketplaceInstallResult {
  readonly ok: boolean;
  readonly skillId?: string;
  readonly error?: string;
}

/**
 * 市场横向筛选 / 排序语义：
 * - score: 全部 / 综合评分
 * - featured: 推荐精选（认证优先，再按评分）
 * - rising: 近期飙升（近期更新 + 下载量，本地近似）
 * - downloads: 下载量
 * - stars: 收藏量
 * - created: 最近上新
 * - updated: 最近更新
 */
export type SkillHubMarketplaceSort =
  | 'score'
  | 'featured'
  | 'rising'
  | 'downloads'
  | 'stars'
  | 'created'
  | 'updated';

export interface SkillHubMarketplaceEntry {
  readonly catalogId: string;
  readonly namespace: string;
  readonly canonicalName: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly descriptionOriginal: string;
  readonly version: string;
  readonly category: string;
  readonly subCategories: readonly { readonly key: string; readonly name: string }[];
  readonly labels: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly iconUrl: string | null;
  readonly ownerName: string;
  readonly score: number;
  readonly downloads: number;
  readonly installs: number;
  readonly stars: number;
  readonly verified: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SkillHubSyncStatus {
  readonly status: 'idle' | 'syncing' | 'error';
  readonly nextPage: number;
  readonly total: number;
  readonly indexed: number;
  readonly updatedAt: number | null;
  readonly error: string | null;
  readonly skipped: number;
  readonly skippedReasons: Readonly<Record<string, number>>;
}

export interface SkillHubMarketplaceQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly keyword?: string;
  readonly category?: string;
  readonly sortBy?: SkillHubMarketplaceSort;
}

export interface SkillHubMarketplacePage {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly SkillHubMarketplaceEntry[];
  readonly sync: SkillHubSyncStatus;
}

/** SkillHub 安装作用域：全局用户目录或当前工作区 skills/。 */
export type SkillHubInstallScope = 'global' | 'workspace';

export interface SkillHubInstallRequest {
  readonly namespace: string;
  readonly slug: string;
  readonly version: string;
  /** 默认 global；workspace 需已打开工作区。 */
  readonly scope?: SkillHubInstallScope;
  /** 市场图标 URL；安装时写入本地 _meta.json，供已安装列表展示。 */
  readonly iconUrl?: string | null;
}

export interface SkillHubCategory {
  readonly key: string;
  readonly name: string;
  readonly nameEn: string;
  readonly sortOrder: number;
  readonly active: boolean;
  readonly level: number;
  readonly version: number;
}

export interface SkillHubCategoriesResult {
  readonly count: number;
  readonly items: readonly SkillHubCategory[];
}

// ---------------------------------------------------------------------------
// Qoder 市场（qoder.com apphub）
//
// 数据来自 qoder.com 官方 marketplace apphub API（无需鉴权）：
// - 列表：GET /apphub/api/v1/marketplace/catalog/extensions?extension_types=skill
// - 详情：GET /apphub/api/v1/marketplace/skills/{skillId}/detail
// - 分类：GET /apphub/api/v1/marketplace/extensions/taxonomies?extension_type=skill
// - 下载：detail.download_url（OSS zip，直链）
// 与 SkillHub 不同：Qoder 支持服务端关键词搜索 + 分页，无需本地全量索引同步。
// ---------------------------------------------------------------------------

export type QoderMarketplaceSort = 'hot' | 'latest';

/** 筛选维度：category（20 个分类）/ output（9 种产物）/ client（5 个客户端）/ app_ecosystem（8 个生态）。 */
export type QoderTaxonomyDimension = 'category' | 'output' | 'client' | 'app_ecosystem';

export interface QoderTaxonomyItem {
  readonly dimension: QoderTaxonomyDimension;
  /** 传回列表接口的 code（如 "Coding"、"document"、"github"）。 */
  readonly code: string;
  /** 本地化标签：taxonomies 接口支持 Accept-Language: zh，直接返回中文（如「办公效率」）。 */
  readonly label: string;
  readonly description: string;
  readonly sortOrder: number;
}

export interface QoderTaxonomiesResult {
  readonly count: number;
  readonly items: readonly QoderTaxonomyItem[];
}

export interface QoderMarketplaceEntry {
  readonly skillId: string;
  readonly name: string;
  readonly nameCn: string;
  readonly description: string;
  readonly descriptionCn: string;
  readonly iconUrl: string | null;
  readonly author: string;
  readonly authorName: string;
  readonly installCount: number;
  readonly category: string;
  /** epoch 毫秒（接口返回字符串） */
  readonly contentUpdatedAt: number;
}

export interface QoderMarketplaceQuery {
  readonly keyword?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sortBy?: QoderMarketplaceSort;
  /** 分类筛选（如 ['Coding']；多值为 AND 关系，服务端语义）。 */
  readonly categories?: readonly string[];
  /** 产物类型筛选（如 ['document','code']）。 */
  readonly outputs?: readonly string[];
  /** 客户端筛选（如 ['qoder']）。 */
  readonly clients?: readonly string[];
  /** App 生态筛选（如 ['github','feishu']）。 */
  readonly appEcosystems?: readonly string[];
}

export interface QoderMarketplacePage {
  readonly currentPage: number;
  readonly nextPage: number | null;
  readonly lastPage: number;
  readonly pageSize: number;
  readonly totalSize: number;
  readonly items: readonly QoderMarketplaceEntry[];
}

export interface QoderMarketplaceFileNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size: number;
  readonly files: readonly QoderMarketplaceFileNode[];
}

export interface QoderMarketplaceSkillDetail {
  readonly skillId: string;
  readonly name: string;
  readonly nameCn: string;
  readonly description: string;
  readonly descriptionCn: string;
  readonly iconUrl: string | null;
  readonly author: string;
  readonly authorName: string;
  readonly installCount: number;
  readonly category: string;
  readonly version: string;
  readonly downloadUrl: string;
  readonly githubPath: string | null;
  readonly skillMd: string | null;
  readonly fileTree: QoderMarketplaceFileNode | null;
}

export type QoderInstallScope = 'global' | 'workspace';

export interface QoderInstallIdentity {
  readonly skillId: string;
  readonly scope?: QoderInstallScope;
  readonly iconUrl?: string | null;
}

export interface QoderInstallResult {
  readonly ok: boolean;
  readonly skillId: string;
  readonly installedSkillId: string;
  readonly version: string;
  readonly scope: QoderInstallScope;
}

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GitHubProvider, computeReleaseNotes } = require('electron-updater/out/providers/GitHubProvider.js');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider.js');
const sdkRequire = createRequire(require.resolve('electron-updater/package.json'));
const { CancellationToken, parseXml, newError } = sdkRequire('builder-util-runtime');
const semver = sdkRequire('semver');

export function isStrictlyNewerUpdate(candidate, current) {
  return typeof candidate === 'string' && typeof current === 'string'
    && Boolean(semver.valid(candidate) && semver.valid(current)) && semver.gt(candidate, current);
}

// Frozen SDK seam: retain GitHub HTTP, file resolution and verified download paths.
// Peer publishes alpha/beta/rc to beta*.yml; SDK 6.8.9 treats rc as a custom channel.
export class PeerGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    const token = new CancellationToken();
    const rawFeed = await this.httpRequest(new URL(`${this.basePath}.atom`, this.baseUrl), {
      accept: 'application/xml, application/atom+xml, text/xml, */*',
    }, token);
    const feed = parseXml(rawFeed);
    const entries = feed.getElements('entry');
    const previews = this.updater.channel === 'beta';
    let selected;
    if (previews) {
      for (const entry of entries) {
        const tag = entry.element('link', false)?.attribute('href')?.match(/\/tag\/(v?[^/]+)$/)?.[1];
        const version = semver.valid(tag);
        const lane = version && semver.prerelease(version)?.[0];
        if (!['alpha', 'beta', 'rc'].includes(lane)) continue;
        if (!selected || semver.gt(version, selected.version)) selected = { tag, version: tag.replace(/^v/, ''), entry };
      }
    } else {
      const tag = await super.getLatestTagName(token);
      if (!semver.valid(tag) || semver.prerelease(tag)) {
        throw newError('Stable endpoint returned an invalid or preview tag', 'ERR_UPDATER_INVALID_RELEASE_FEED');
      }
      const entry = entries.find(item => item.element('link', false)?.attribute('href')?.endsWith(`/tag/${tag}`));
      selected = { tag, version: tag.replace(/^v/, ''), entry };
    }
    if (!selected) throw newError('No published preview versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS');
    const channelFile = `${this.getCustomChannelName(previews ? 'beta' : 'latest')}.yml`;
    const channelUrl = new URL(this.getBaseDownloadPath(selected.tag, channelFile), this.baseUrl);
    const rawManifest = await this.httpRequest(channelUrl, undefined, token);
    const info = parseUpdateInfo(rawManifest, channelFile, channelUrl.href);
    if (typeof info?.version !== 'string' || info.version.replace(/^v/, '') !== selected.version) {
      throw newError('Manifest version does not match the selected release tag', 'ERR_UPDATER_INVALID_UPDATE_INFO');
    }
    if (!info.releaseName) info.releaseName = selected.entry?.elementValueOrEmpty('title') || selected.tag;
    if (info.releaseNotes == null && selected.entry) {
      info.releaseNotes = computeReleaseNotes(this.updater.currentVersion, this.updater.fullChangelog, feed, selected.entry);
    }
    return { ...info, tag: selected.tag };
  }
}

export async function installPeerGitHubProvider(updater) {
  // Read the SDK's cached packaged configuration, including its original host/repo.
  const options = await updater.configOnDisk.value;
  if (options.provider !== 'github' || options.private || options.token) return false;
  updater.setFeedURL({ ...options, provider: 'custom', updateProvider: PeerGitHubProvider });
  return true;
}

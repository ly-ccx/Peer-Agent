import assert from 'node:assert/strict';
import path from 'node:path';
import { BOT_AVATAR_COLORS } from '@peer-agent/protocol';

/** Change the real isolated bot profile, then inspect production message paint. */
export async function checkBotMessageColors({ page, until, report, captureDirectory }) {
  const workspaceId = (await page.locator('.bot-row.is-open').getAttribute('id')).slice('bot-row-'.length);
  const original = await page.evaluate(async workspaceId => ({
    avatar: (await window.peerAgent.projectAgentGet({ workspaceId })).item.profile.avatar,
    theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }), workspaceId);
  const reply = page.locator('#bot-msg-rc-message-9999');
  const changeColor = async color => {
    await page.locator('.bot-profile').click();
    await page.getByRole('tab', { name: '设置', exact: true }).click();
    const swatch = page.locator('.bot-avatar-color');
    const index = BOT_AVATAR_COLORS.indexOf(color);
    assert.ok(index >= 0);
    await swatch.nth(index).click();
    await until(() => swatch.nth(index).getAttribute('aria-pressed'), value => value === 'true');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await until(() => page.locator('.bot-convo').evaluate(node => node.style.getPropertyValue('--bot-message-accent')), value => value === color);
    await reply.scrollIntoViewIfNeeded();
  };
  const cases = [];
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const color of BOT_AVATAR_COLORS) {
      await changeColor(color);
      for (const palette of ['frost', 'catppuccin']) for (const theme of ['dark', 'light']) {
        await page.evaluate(async ({ palette, theme }) => {
          document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
        }, { palette, theme });
        const sample = await reply.evaluate(node => {
          const bubble = node.querySelector('.bot-reply-body'), style = getComputedStyle(bubble);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const rgb = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
          const lum = color => rgb(color).map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
            .reduce((total, x, i) => total + x * [0.2126, 0.7152, 0.0722][i], 0);
          const contrast = foreground => {
            const values = [lum(foreground), lum(style.backgroundColor)].sort((a, b) => b - a);
            return (values[0] + 0.05) / (values[1] + 0.05);
          };
          const user = document.querySelector('.bot-user-content');
          const body = bubble.getBoundingClientRect(), column = node.getBoundingClientRect();
          return { accent: node.closest('.bot-convo').style.getPropertyValue('--bot-message-accent'),
            avatar: node.closest('.bot-thread-row').querySelector('.bot-avatar').style.getPropertyValue('--bot-avatar-accent'),
            background: style.backgroundColor, bodyColor: style.color,
            quoteColor: getComputedStyle(node.querySelector('.bot-reply-bar-excerpt')).color,
            secondaryColor: style.getPropertyValue('--bot-reply-secondary'), bodyContrast: contrast(style.color),
            quoteContrast: contrast(getComputedStyle(node.querySelector('.bot-reply-bar-excerpt')).color),
            userBackground: user ? rgb(getComputedStyle(user).backgroundColor) : null,
            neutralBackground: rgb(getComputedStyle(node).getPropertyValue('--paper-hover')),
            fits: body.left >= column.left && body.right <= column.right };
        });
        assert.equal(sample.accent, color); assert.equal(sample.avatar, color);
        assert.ok(sample.bodyContrast >= 4.5 && sample.quoteContrast >= 4.5, JSON.stringify({ color, palette, theme, ...sample }));
        assert.ok(sample.fits);
        if (sample.userBackground) assert.deepEqual(sample.userBackground, sample.neutralBackground);
        cases.push({ color, palette, theme, ...sample });
        const names = { '#a884e5': 'purple', '#e774ad': 'pink', '#61b68c': 'green' };
        if (captureDirectory && palette === 'frost' && names[color]) {
          await reply.locator('..').screenshot({ animations: 'disabled', path: path.join(captureDirectory, `bot-message-${names[color]}-${theme}.png`) });
        }
      }
    }
    const firstColor = await page.locator('.bot-convo').evaluate(node => node.style.getPropertyValue('--bot-message-accent'));
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-001' }) }).click();
    await until(() => page.locator('.bot-main-title').innerText(), name => name === 'project-001');
    const switched = await page.locator('.bot-convo').evaluate(node => ({
      accent: node.style.getPropertyValue('--bot-message-accent'),
      avatar: document.querySelector('.bot-main-head .bot-avatar').style.getPropertyValue('--bot-avatar-accent'),
    }));
    assert.equal(switched.accent, switched.avatar);
    await page.locator(`#bot-row-${workspaceId}`).click();
    await until(() => page.locator('.bot-convo').evaluate(node => node.style.getPropertyValue('--bot-message-accent')), color => color === firstColor);
    report.botMessageColors = { cases, identitySwitch: true, savedColorApplied: true };
  } finally {
    await page.locator(`#bot-row-${workspaceId}`).click();
    await changeColor(original.avatar.color);
    await page.locator('.bot-profile').click();
    await page.getByRole('tab', { name: '概况', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(original => {
      for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
    }, original);
    await page.emulateMedia({ reducedMotion: original.reducedMotion ? 'reduce' : 'no-preference' });
  }
}

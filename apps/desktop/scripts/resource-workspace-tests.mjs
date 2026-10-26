/** Phase-one resource modules + real isolated Chrome CSS check. Build workspace dependencies first. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const files = [
  "apps/desktop/electron/main/bot-document-reference.test.mjs",
  "apps/desktop/electron/main/file-access-application-service.test.mjs",
  "apps/desktop/electron/main/ipc/register-file-access-ipc.test.mjs",
  "apps/desktop/electron/main/ipc/register-workspace-ipc.test.mjs",
  "apps/desktop/electron/main/workspace-file-search.test.mjs",
  "apps/desktop/renderer/src/chat/components/markdown/codeHighlighter.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/documentReference.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/inlineMarkdownImages.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/inlineMarkdownLinks.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/inlineMarkdownPreview.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/markdownFenceSanitizer.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/markdownListCluster.test.ts",
  "apps/desktop/renderer/src/chat/components/markdown/markdownSource.test.ts",
  "apps/desktop/renderer/src/project-agent/conversation/useConversationWindow.browser.test.ts",
  "apps/desktop/renderer/src/project-agent/state/botResourceReference.test.ts",
  "apps/desktop/renderer/src/ui/resources/resourceState.test.ts",
  "apps/desktop/renderer/src/workbench/ScopedDocumentPage.test.ts",
  "apps/desktop/renderer/src/workbench/browserPanelReveal.test.ts",
  "apps/desktop/renderer/src/workbench/browserSessionState.test.ts",
  "apps/desktop/renderer/src/workbench/documentSessionState.test.ts",
  "apps/desktop/renderer/src/workbench/file-preview/DiffViewer.test.ts",
  "apps/desktop/renderer/src/workbench/file-preview/fileTypes.test.ts",
  "apps/desktop/renderer/src/workbench/file-preview/sourceHighlight.test.ts",
  "apps/desktop/renderer/src/workbench/resourceComparisonState.test.ts",
  "apps/desktop/renderer/src/workbench/resourceWorkspaceState.test.ts",
  "apps/desktop/renderer/src/workbench/useDocumentReadingPosition.test.ts",
  "apps/desktop/renderer/src/workbench/views/filesTreeFilter.test.ts",
  "apps/desktop/renderer/src/workbench/views/filesTreePresentation.test.ts",
  "apps/desktop/renderer/src/workbench/views/filesTreeRefresh.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchBrowserVisibility.browser.test.mjs",
  "apps/desktop/renderer/src/workbench/workbenchBrowserVisibility.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchLayoutProjection.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchMaximize.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchOpenState.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchResizeStages.test.ts",
  "apps/desktop/renderer/src/workbench/workbenchTabState.test.ts",
  "packages/conversation-store/src/interaction-reader.test.mjs",
  "packages/runtime-node/src/project-agent/bot-resource-references.test.mjs",
  "packages/runtime-node/src/project-agent/turn-activity.test.mjs",
  "packages/system-context/src/sources/runtime-source.test.mjs"
];
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    PEER_PLAYWRIGHT_MODULE: process.env.PEER_PLAYWRIGHT_MODULE || import.meta.resolve('playwright-core'),
  },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

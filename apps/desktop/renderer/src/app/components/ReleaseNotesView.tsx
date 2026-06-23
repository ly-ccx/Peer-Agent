import { Fragment, type ReactNode } from 'react';
import {
  parseReleaseNotesHtml,
  nodesToPlainText,
  type ReleaseNotesNode,
} from './releaseNotesHtml.ts';

/**
 * ReleaseNotesView —— 把更新说明（GitHub 渲染后的 HTML 片段）安全地呈现为富文本。
 *
 * 表达层职责：仅负责把 releaseNotesHtml.ts 解析出的白名单节点树映射为 React 元素。
 * 不使用 dangerouslySetInnerHTML；解析在纯函数里完成并已被单测覆盖。
 * 解析结果为空时回退为纯文本，避免出现空白。
 */
export function ReleaseNotesView({ html }: { html: string }) {
  const nodes = parseReleaseNotesHtml(html);
  if (nodes.length === 0) {
    const fallback = nodesToPlainText(parseReleaseNotesHtml(html)) || html;
    return <pre className="updater-notes-plain">{fallback}</pre>;
  }
  return <div className="updater-notes-rich">{renderNodes(nodes)}</div>;
}

function renderNodes(nodes: ReleaseNotesNode[]): ReactNode[] {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node)}</Fragment>);
}

function renderNode(node: ReleaseNotesNode): ReactNode {
  if (node.kind === 'text') return node.text;

  const children = renderNodes(node.children);
  switch (node.tag) {
    case 'br':
      return <br />;
    case 'hr':
      return <hr />;
    case 'p':
      return <p>{children}</p>;
    case 'ul':
      return <ul>{children}</ul>;
    case 'ol':
      return <ol>{children}</ol>;
    case 'li':
      return <li>{children}</li>;
    case 'strong':
      return <strong>{children}</strong>;
    case 'em':
      return <em>{children}</em>;
    case 'code':
      return <code>{children}</code>;
    case 'pre':
      return <pre>{children}</pre>;
    case 'blockquote':
      return <blockquote>{children}</blockquote>;
    case 'h1':
      return <h1>{children}</h1>;
    case 'h2':
      return <h2>{children}</h2>;
    case 'h3':
      return <h3>{children}</h3>;
    case 'h4':
      return <h4>{children}</h4>;
    case 'h5':
      return <h5>{children}</h5>;
    case 'h6':
      return <h6>{children}</h6>;
    case 'a':
      return node.href ? (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <Fragment>{children}</Fragment>
      );
    default:
      return <Fragment>{children}</Fragment>;
  }
}

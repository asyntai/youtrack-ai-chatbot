import React, {type ReactNode} from 'react';

/**
 * Asyntai replies use a little Markdown: **bold**, [links](https://...),
 * and "* item" or "- item" lists. This turns that into React elements, so
 * the agent reads the reply the way the visitor saw it in the chat. No HTML
 * is ever injected, so nothing from a chat can run in YouTrack.
 */

const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
const BOLD = /^\*\*(.+)\*\*$/;
const LINK_TEXT = 1;
const LINK_URL = 2;
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;
const BULLET = /^\s*[*-]\s+/;

// Keys: a chat message never changes once written, so a position-based key
// is stable for the life of the element.
function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    const bold = BOLD.exec(part);
    if (bold) {
      return <strong key={key}>{bold[1]}</strong>;
    }
    const link = LINK.exec(part);
    if (link) {
      return <a key={key} href={link[LINK_URL]} target="_blank" rel="noreferrer">{link[LINK_TEXT]}</a>;
    }
    return part;
  });
}

export default function Markdown({text}: {text: string}) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];

  const flushList = () => {
    if (list.length) {
      blocks.push(<ul key={`ul-${blocks.length}`} className="asyntai-md-list">{list}</ul>);
      list = [];
    }
  };

  text.split('\n').forEach((line, index) => {
    if (BULLET.test(line)) {
      // eslint-disable-next-line react/no-array-index-key
      list.push(<li key={`li-${index}`}>{inline(line.replace(BULLET, ''), `l${index}`)}</li>);
      return;
    }
    flushList();
    if (line.trim()) {
      // eslint-disable-next-line react/no-array-index-key
      blocks.push(<p key={`p-${index}`} className="asyntai-md-p">{inline(line, `p${index}`)}</p>);
    }
  });
  flushList();
  return <div className="asyntai-md">{blocks}</div>;
}

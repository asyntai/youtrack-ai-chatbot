import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Loader from '@jetbrains/ring-ui-built/components/loader/loader';
import Text from '@jetbrains/ring-ui-built/components/text/text';

import Markdown from './markdown';

const host = await YTApp.register();

interface Message {
  role: string;
  content: string;
  timestamp?: string;
}

interface Chat {
  session_id: string;
  page_url: string;
  started_at: string;
  messages: Message[];
}

interface ChatsResult {
  email?: string;
  chats?: Chat[];
  state?: string;
  fresh?: boolean;
  error?: string;
  message?: string;
}

interface DraftResult {
  draft?: string;
  state?: string;
  error?: string;
  message?: string;
}

// The backend hands every Asyntai call to YouTrack to run after the request
// returns, and stores the result on the issue. The widget asks again until the
// state is "ready" or "error".
const POLL_MS = 1500;
const POLL_LIMIT_MS = 90000;
const DONE_STATES = ['ready', 'error'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Starts a job with POST, then reads GET until the job is done.
 *
 * The POST answer is enough when the backend already holds a fresh result
 * or a finished one, so the loop only runs while the state is pending.
 */
async function pollJob<T extends {state?: string; fresh?: boolean}>(
  path: string, isCancelled: () => boolean
): Promise<T> {
  let data = await host.fetchApp<T>(path, {method: 'POST', scope: true, body: {}});
  const started = Date.now();
  while (!isCancelled() && !data.fresh && !DONE_STATES.includes(data.state ?? '')) {
    if (Date.now() - started > POLL_LIMIT_MS) {
      return {...data, state: 'error', error: 'Asyntai did not answer in time.'};
    }
    await sleep(POLL_MS);
    data = await host.fetchApp<T>(path, {scope: true});
  }
  return data;
}

// Enough of the text to tell two messages apart without holding the whole
// message in the key.
const KEY_TEXT_CHARS = 24;

/**
 * A stable key for one message.
 *
 * Two messages in the same chat can share a timestamp and a role, so the
 * position is part of the key. It is built here rather than inline because
 * a bare index key hides a reorder from React.
 */
function messageKey(sessionId: string, message: Message, index: number): string {
  return [sessionId, index, message.role, message.timestamp ?? '', message.content.slice(0, KEY_TEXT_CHARS)].join('|');
}

/**
 * The YouTrack user's language, which YouTrack passes to the widget frame as
 * "#locale=xx". The browser's own language is not the same thing: an English
 * YouTrack in a Czech browser must still print English dates.
 */
function uiLocale(): string | undefined {
  const locale = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('locale');
  return locale || undefined;
}

function formatDate(value: string): string {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleString(uiLocale(), {dateStyle: 'medium', timeStyle: 'short'});
}

const DraftPanel: React.FunctionComponent<{draft: string}> = ({draft}) => (
  <div className="asyntai-draft">
    <div className="asyntai-draft-head">{'Suggested reply'}</div>
    <div className="asyntai-draft-body"><Markdown text={draft}/></div>
    <div className="asyntai-draft-foot">
      {'Read it before you send it. Your AI agent wrote it from your website and your knowledge base.'}
    </div>
  </div>
);

const ChatRow: React.FunctionComponent<{
  chat: Chat;
  open: boolean;
  onToggle: () => void;
}> = ({chat, open, onToggle}) => (
  <div className="asyntai-chat">
    <button type="button" className="asyntai-chat-head" onClick={onToggle}>
      <span className="asyntai-chat-when">{formatDate(chat.started_at)}</span>
      <span className="asyntai-chat-where">{chat.page_url}</span>
      <span className="asyntai-chat-count">{`${chat.messages.length} messages`}</span>
    </button>
    {open && (
      <div className="asyntai-messages">
        {chat.messages.map((message, index) => (
          <div
            key={messageKey(chat.session_id, message, index)}
            className={message.role === 'user' ? 'asyntai-msg visitor' : 'asyntai-msg agent'}
          >
            <span className="asyntai-who">
              {message.role === 'user' ? 'Visitor' : 'Asyntai'}
            </span>
            <span className="asyntai-text"><Markdown text={message.content}/></span>
          </div>
        ))}
      </div>
    )}
  </div>
);

const ChatList: React.FunctionComponent<{chats: Chat[]; email: string}> = ({chats, email}) => {
  const [openChat, setOpenChat] = useState<string | null>(null);

  if (chats.length === 0) {
    return <div className="asyntai-head">{'No earlier website chats for this person.'}</div>;
  }

  return (
    <>
      <div className="asyntai-head">
        {`Earlier website chats of ${email} (${chats.length})`}
      </div>
      {chats.map(chat => (
        <ChatRow
          key={chat.session_id}
          chat={chat}
          open={openChat === chat.session_id}
          onToggle={() => setOpenChat(openChat === chat.session_id ? null : chat.session_id)}
        />
      ))}
    </>
  );
};

/** Reads the chats of this ticket's visitor, once, on open. */
function useChats() {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ChatsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const settle = (data: ChatsResult) => {
      if (cancelled) {
        return;
      }
      setResult(data);
      setLoading(false);
    };
    pollJob<ChatsResult>('backend/chats', () => cancelled)
      .then(data => settle(data.state === 'error'
        ? {...data, message: data.error || 'Could not read the chats.'}
        : data))
      .catch(() => settle({error: 'unreachable', message: 'Could not read the chats.'}));
    return () => {
      cancelled = true;
    };
  }, []);

  return {loading, result};
}

function draftProblem(data: DraftResult): string {
  return data.error || data.message || 'Asyntai did not write a draft.';
}

/** Asks the Asyntai agent for a reply to this ticket, on demand. */
function useDraft() {
  const [draft, setDraft] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');

  const writeDraft = useCallback(async () => {
    setDrafting(true);
    setDraftError('');
    setDraft('');
    try {
      const data = await pollJob<DraftResult>('backend/draft', () => false);
      setDraft(data.draft ?? '');
      setDraftError(data.draft ? '' : draftProblem(data));
    } catch {
      setDraftError('Asyntai did not answer.');
    }
    setDrafting(false);
  }, []);

  const copyDraft = useCallback(() => {
    navigator.clipboard.writeText(draft).then(
      () => host.alert('Draft copied. Paste it into a comment.'),
      () => host.alert('Could not copy the draft.')
    );
  }, [draft]);

  return {draft, drafting, draftError, writeDraft, copyDraft};
}

/**
 * Everything the agent sees once the chats are in: the draft button, the draft
 * itself, and the earlier conversations.
 *
 * Split from AppComponent, which only decides between loading, an error and
 * this view.
 */
const Loaded: React.FunctionComponent<{result: ChatsResult}> = ({result}) => {
  const {draft, drafting, draftError, writeDraft, copyDraft} = useDraft();

  return (
    <div className="widget">
      <div className="asyntai-actions">
        <Button primary loader={drafting} onClick={writeDraft}>
          {'Draft a reply with Asyntai'}
        </Button>
        {draft ? <Button onClick={copyDraft}>{'Copy'}</Button> : null}
      </div>

      {draftError ? <Text info>{draftError}</Text> : null}
      {draft ? <DraftPanel draft={draft}/> : null}

      <ChatList chats={result.chats ?? []} email={result.email ?? ''}/>
    </div>
  );
};

/** The sentence to show instead of the chats, or '' when all is well. */
function chatsProblem(result: ChatsResult | null): string {
  if (!result) {
    return 'Asyntai did not answer.';
  }
  if (result.error || result.state === 'error') {
    return result.message || result.error || 'Asyntai did not answer.';
  }
  return '';
}

const AppComponent: React.FunctionComponent = () => {
  const {loading, result} = useChats();

  if (loading) {
    return <div className="widget"><Loader message="Reading Asyntai..."/></div>;
  }

  if (!result || chatsProblem(result)) {
    return (
      <div className="widget">
        <Text info>{chatsProblem(result)}</Text>
      </div>
    );
  }

  return <Loaded result={result}/>;
};

export const App = memo(AppComponent);

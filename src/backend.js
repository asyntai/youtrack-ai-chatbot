const http = require('@jetbrains/youtrack-scripting-api/http');

const ASYNTAI_HOST = 'https://asyntai.com';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

// Enough of an error body to recognise it, without pasting a whole page.
const ERROR_BODY_CHARS = 120;

// Five chats fit on a ticket page without pushing the activity stream off the
// screen, and the ticket itself is what the agent came to read.
const MAX_CHATS = 5;

// Enough of a ticket for the agent to answer it. Beyond this the tail is
// usually a quoted mail thread, which teaches the model nothing new.
const MAX_QUESTION_CHARS = 4000;

// A pending job older than this is treated as lost, so the widget can start a
// new one instead of waiting forever on a chain that died.
const SECOND_MS = 1000;
const PENDING_TIMEOUT_SECONDS = 90;
const PENDING_TIMEOUT_MS = PENDING_TIMEOUT_SECONDS * SECOND_MS;

// Cached chats older than this are fetched again when the ticket is opened.
const CHATS_FRESH_SECONDS = 600;
const CHATS_FRESH_MS = CHATS_FRESH_SECONDS * SECOND_MS;

const STATE_PENDING = 'pending';
const STATE_READY = 'ready';
const STATE_ERROR = 'error';

// Asyntai writes this line into every ticket it pushes, because YouTrack does
// not let an API caller set the reporter of a helpdesk ticket. It is the first
// place to look for the address of the person who actually wrote in.
const VISITOR_LINE = /\*\*Visitor:\*\*\s*([^\s<>]+@[^\s<>]+)/;
const ANY_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

// Widget bookkeeping that lands in the transcript as a visitor message, for
// example "[EMAIL_SUBMITTED]name@example.com". An agent reads the chat, not
// the plumbing.
const MARKER_MESSAGE = /^\[[A-Z_]+\]/;

function readable(messages) {
  return (messages || []).filter(m => !MARKER_MESSAGE.test(String(m.content || '')));
}

/**
 * A connection to Asyntai, signed with the key from the app settings.
 *
 * A secret setting is masked in JavaScript: ctx.settings.apiKey reads as
 * "<***>". YouTrack puts the real value in only when that masked value goes
 * to its own http package unchanged, so bearerAuth() is the one way to use
 * it. 'Bearer ' + apiKey sends the mask, and Asyntai answers 401.
 */
function connect(apiKey) {
  const connection = new http.Connection(ASYNTAI_HOST);
  connection.bearerAuth(apiKey);
  connection.addHeader('Accept', 'application/json');
  connection.addHeader('Content-Type', 'application/json');
  return connection;
}

/**
 * A query string built here, not by the HTTP package.
 *
 * A visitor address such as name+tag@example.com must reach Asyntai with the
 * plus sign intact. Left to the package, it arrived as a space and the lookup
 * found nothing.
 */
function query(object) {
  return '?' + Object.keys(object)
    .map(name => encodeURIComponent(name) + '=' + encodeURIComponent(String(object[name])))
    .join('&');
}

function explain(code, body) {
  if (code === HTTP_UNAUTHORIZED) {
    return 'Asyntai refused the API key. Check the key in the app settings.';
  }
  if (code === HTTP_FORBIDDEN) {
    return 'This Asyntai plan has no API access. The Starter plan or higher is needed.';
  }
  if (!code) {
    return 'Asyntai did not answer.';
  }
  return 'Asyntai answered ' + code + '. ' + String(body || '').substring(0, ERROR_BODY_CHARS);
}

/**
 * The parsed body of an async response, or null with the reason in `.error`.
 *
 * The status matters to the person reading the widget: 401 means the key is
 * wrong, 403 means the plan has no API access, and anything else means
 * Asyntai or the network. Each gets its own sentence.
 */
function readAsync(response) {
  const code = response ? Number(response.code) : 0;
  if (code !== HTTP_OK) {
    return {data: null, error: explain(code, response ? response.body : '')};
  }
  try {
    return {data: JSON.parse(response.body), error: ''};
  } catch {
    return {data: null, error: 'Asyntai returned an unreadable answer.'};
  }
}

function reporterEmail(issue) {
  const reporter = issue && issue.reporter;
  return (reporter && reporter.email) || '';
}

/**
 * Which visitor this ticket is about.
 *
 * A ticket pushed by Asyntai carries the address in its body. A ticket that
 * arrived by email carries a real reporter instead, so both are checked.
 */
function visitorEmail(issue) {
  const description = (issue && issue.description) || '';
  const tagged = VISITOR_LINE.exec(description);
  if (tagged) {
    return tagged[1];
  }
  const reporter = reporterEmail(issue);
  if (reporter) {
    return reporter;
  }
  const loose = ANY_EMAIL.exec(description);
  return loose ? loose[0] : '';
}

/** The question to answer: the summary plus the body, without our own footer. */
function ticketQuestion(issue) {
  const summary = (issue && issue.summary) || '';
  let description = (issue && issue.description) || '';
  const cut = description.indexOf('\n---\n');
  if (cut > -1) {
    description = description.substring(0, cut);
  }
  return (summary + '\n\n' + description).trim().substring(0, MAX_QUESTION_CHARS);
}

function missingKey(ctx) {
  const apiKey = ctx.settings && ctx.settings.apiKey;
  if (!apiKey) {
    ctx.response.code = HTTP_OK;
    ctx.response.json({
      error: 'no_api_key',
      message: 'Add your Asyntai API key in the app settings.'
    });
    return true;
  }
  return false;
}

/*
 * Every call to Asyntai runs after the HTTP request has returned, with the
 * async HTTP methods YouTrack added in 2026.2. A request thread is never held
 * while Asyntai thinks. The result lands in extension properties on the
 * issue, and the widget polls the GET endpoints until the state is ready.
 *
 * YouTrack allows one async call per script execution, so the chats are
 * fetched as a chain: the leads first, then one conversation per step.
 */

function isStale(props, atName, stateName) {
  const at = Number(props[atName] || 0);
  const age = Date.now() - at;
  if (props[stateName] === STATE_PENDING) {
    return age > PENDING_TIMEOUT_MS;
  }
  return true;
}

function parseList(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isFresh(props) {
  return props.asyntaiChatsState === STATE_READY &&
    Date.now() - Number(props.asyntaiChatsAt || 0) < CHATS_FRESH_MS;
}

function chatsPayload(issue) {
  const props = issue.extensionProperties;
  return {
    email: props.asyntaiChatsEmail || visitorEmail(issue),
    state: props.asyntaiChatsState || '',
    chats: parseList(props.asyntaiChats),
    updated_at: Number(props.asyntaiChatsAt || 0),
    error: props.asyntaiChatsError || '',
    fresh: isFresh(props)
  };
}

function draftPayload(issue) {
  const props = issue.extensionProperties;
  return {
    state: props.asyntaiDraftState || '',
    draft: props.asyntaiDraft || '',
    updated_at: Number(props.asyntaiDraftAt || 0),
    error: props.asyntaiDraftError || ''
  };
}

function finishChats(issue, chats, error) {
  const props = issue.extensionProperties;
  props.asyntaiChats = JSON.stringify(chats || []);
  props.asyntaiChatsError = error || '';
  props.asyntaiChatsState = error ? STATE_ERROR : STATE_READY;
  props.asyntaiChatsAt = Date.now();
}

function finishDraft(issue, draft, error) {
  const props = issue.extensionProperties;
  props.asyntaiDraft = draft || '';
  props.asyntaiDraftError = error || '';
  props.asyntaiDraftState = error ? STATE_ERROR : STATE_READY;
  props.asyntaiDraftAt = Date.now();
}

function chatOf(lead, messages) {
  const source = lead || {};
  return {
    session_id: source.session_id || '',
    page_url: source.page_url || '',
    started_at: source.started_at || '',
    messages: readable(messages)
  };
}

/** Asks Asyntai for the next conversation in the list, or finishes. */
function nextConversation(ctx, apiKey, leads, index, chats) {
  if (index >= leads.length) {
    finishChats(ctx.issue, chats, '');
    return;
  }
  ctx.store('leads', JSON.stringify(leads));
  ctx.store('index', index);
  ctx.store('chats', JSON.stringify(chats));
  connect(apiKey).getAsync('/api/v1/conversations/' + query({
    session_id: leads[index].session_id,
    limit: 100
  }), [], 'onConversation');
}

function startChats(ctx, email) {
  const props = ctx.issue.extensionProperties;
  props.asyntaiChatsState = STATE_PENDING;
  props.asyntaiChatsEmail = email;
  props.asyntaiChatsError = '';
  props.asyntaiChatsAt = Date.now();
  connect(ctx.settings.apiKey).getAsync('/api/v1/leads/' + query({
    email: email,
    limit: 10
  }), [], 'onLeads');
}

function startDraft(ctx, question) {
  const props = ctx.issue.extensionProperties;
  props.asyntaiDraftState = STATE_PENDING;
  props.asyntaiDraftError = '';
  props.asyntaiDraftAt = Date.now();
  // A fresh session per draft. The ticket text carries its own context, and
  // reusing the visitor's session would write the agent's request into the
  // customer's own chat history.
  connect(ctx.settings.apiKey).postAsync('/api/v1/chat/', [], JSON.stringify({
    message: question,
    session_id: 'youtrack_' + (ctx.issue.id || 'draft')
  }), 'onDraft');
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'issue',
      method: 'GET',
      path: 'chats',
      handle: function handle(ctx) {
        if (missingKey(ctx)) {
          return;
        }
        ctx.response.json(chatsPayload(ctx.issue));
      }
    },
    {
      // Starts a fetch of the visitor's chats, unless one is running or the
      // cache is fresh. The widget reads the result from GET chats.
      scope: 'issue',
      method: 'POST',
      path: 'chats',
      handle: function handle(ctx) {
        if (missingKey(ctx)) {
          return;
        }
        const email = visitorEmail(ctx.issue);
        if (!email) {
          finishChats(ctx.issue, [], '');
          ctx.response.json(chatsPayload(ctx.issue));
          return;
        }
        const props = ctx.issue.extensionProperties;
        const current = chatsPayload(ctx.issue);
        const sameVisitor = props.asyntaiChatsEmail === email;
        if (sameVisitor && (current.fresh || !isStale(props, 'asyntaiChatsAt', 'asyntaiChatsState'))) {
          ctx.response.json(current);
          return;
        }
        startChats(ctx, email);
        ctx.response.json(chatsPayload(ctx.issue));
      }
    },
    {
      scope: 'issue',
      method: 'GET',
      path: 'draft',
      handle: function handle(ctx) {
        if (missingKey(ctx)) {
          return;
        }
        ctx.response.json(draftPayload(ctx.issue));
      }
    },
    {
      // Asks the agent for a reply. The widget reads it from GET draft.
      scope: 'issue',
      method: 'POST',
      path: 'draft',
      handle: function handle(ctx) {
        if (missingKey(ctx)) {
          return;
        }
        const question = ticketQuestion(ctx.issue);
        if (!question) {
          ctx.response.json({state: STATE_ERROR, draft: '', error: 'This ticket has no text to answer.'});
          return;
        }
        const props = ctx.issue.extensionProperties;
        if (!isStale(props, 'asyntaiDraftAt', 'asyntaiDraftState')) {
          ctx.response.json(draftPayload(ctx.issue));
          return;
        }
        startDraft(ctx, question);
        ctx.response.json(draftPayload(ctx.issue));
      }
    }
  ],

  asyncFunctions: {
    onLeads: function onLeads(ctx) {
      const result = readAsync(ctx.response);
      if (!result.data || !result.data.success) {
        finishChats(ctx.issue, [], result.error || 'Asyntai did not answer.');
        return;
      }
      // Newest first, which is how the API returns them.
      const leads = (result.data.leads || []).slice(0, MAX_CHATS).map(lead => ({
        session_id: lead.session_id,
        page_url: lead.page_url || '',
        started_at: lead.started_at || ''
      }));
      nextConversation(ctx, ctx.settings.apiKey, leads, 0, []);
    },

    onConversation: function onConversation(ctx) {
      const leads = parseList(ctx.load('leads'));
      const index = Number(ctx.load('index') || 0);
      const chats = parseList(ctx.load('chats'));
      const history = readAsync(ctx.response).data || {};
      chats.push(chatOf(leads[index], history.messages));
      nextConversation(ctx, ctx.settings.apiKey, leads, index + 1, chats);
    },

    onDraft: function onDraft(ctx) {
      const result = readAsync(ctx.response);
      if (!result.data || !result.data.success) {
        finishDraft(ctx.issue, '', result.error || 'Asyntai did not answer.');
        return;
      }
      finishDraft(ctx.issue, result.data.response || '', '');
    }
  }
};

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

/**
 * The parsed body, or null with the reason kept on `lastFailure`.
 *
 * The status matters to the person reading the widget: 401 means the key is
 * wrong, 403 means the plan has no API access, and anything else means
 * Asyntai or the network. Each gets its own sentence.
 */
let lastFailure = '';

function readJson(response) {
  const code = response ? Number(response.code) : 0;
  if (code !== HTTP_OK) {
    lastFailure = explain(code, response ? String(response.response || '') : '');
    return null;
  }
  try {
    return JSON.parse(response.response);
  } catch {
    lastFailure = 'Asyntai returned an unreadable answer.';
    return null;
  }
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
  return 'Asyntai answered ' + code + '. ' + body.substring(0, ERROR_BODY_CHARS);
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

/**
 * One answer from the agent for this ticket.
 *
 * A fresh session per draft. The ticket text carries its own context, and
 * reusing the visitor's session would write the agent's request into the
 * customer's own chat history.
 */
function askAsyntai(apiKey, question, issueId) {
  const connection = connect(apiKey);
  return readJson(connection.postSync('/api/v1/chat/', [], JSON.stringify({
    message: question,
    session_id: 'youtrack_' + (issueId || 'draft')
  })));
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
        const email = visitorEmail(ctx.issue);
        if (!email) {
          ctx.response.json({email: '', chats: []});
          return;
        }

        const connection = connect(ctx.settings.apiKey);
        const leads = readJson(connection.getSync('/api/v1/leads/' + query({
          email: email,
          limit: 10
        }), []));
        if (!leads || !leads.success) {
          ctx.response.json({
            email: email,
            error: 'asyntai_unreachable',
            message: lastFailure || 'Asyntai did not answer.'
          });
          return;
        }

        // Newest first, which is how the API returns them.
        const chats = (leads.leads || []).slice(0, MAX_CHATS).map(lead => {
          const history = readJson(connection.getSync('/api/v1/conversations/' + query({
            session_id: lead.session_id,
            limit: 100
          }), []));
          return {
            session_id: lead.session_id,
            page_url: lead.page_url || '',
            started_at: lead.started_at || '',
            messages: readable(history && history.messages)
          };
        });

        ctx.response.json({email: email, chats: chats});
      }
    },
    {
      scope: 'issue',
      method: 'POST',
      path: 'draft',
      handle: function handle(ctx) {
        if (missingKey(ctx)) {
          return;
        }
        const question = ticketQuestion(ctx.issue);
        if (!question) {
          ctx.response.json({error: 'empty_ticket', message: 'This ticket has no text to answer.'});
          return;
        }

        const answer = askAsyntai(ctx.settings.apiKey, question, ctx.issue.id);
        if (!answer || !answer.success) {
          ctx.response.json({
            error: 'asyntai_unreachable',
            message: lastFailure || 'Asyntai did not answer.'
          });
          return;
        }
        ctx.response.json({draft: answer.response || ''});
      }
    }
  ]
};

# Asyntai AI Chatbot for YouTrack

A YouTrack app that brings your [Asyntai](https://asyntai.com) AI chat agent into the YouTrack Helpdesk.

Your AI agent answers visitors on your website all day. When a visitor has a real problem, the agent opens a support ticket, and the same ticket appears in your YouTrack helpdesk with the whole conversation. The visitor is the reporter, so your team answers from YouTrack like any other ticket.

## What the app adds to every ticket

- **Draft a reply with Asyntai.** One button. Your AI agent writes an answer from your website and your knowledge base. Read it, change it, post it.
- **Earlier website chats.** Every chat that person had on your website, newest first, with the full text of every message.

## Install

1. Install **Asyntai AI Chatbot** from the JetBrains Marketplace into your YouTrack.
2. Open the app settings and paste your Asyntai API key (Asyntai → Settings → API).
3. Attach the app to your helpdesk project.

Ticket sync is set up on the Asyntai side: [YouTrack integration guide](https://asyntai.com/documentation/integrations/youtrack/).

## Build

```bash
npm install
npm run build      # type check, bundle, validate the manifest
npm run pack       # asyntai-ai-chatbot.zip
```

Upload to a workspace for testing with `YOUTRACK_HOST` and `YOUTRACK_TOKEN` set:

```bash
npx youtrack-app app upload --directory dist
```

## Requirements

- YouTrack 2026.1 or later, cloud or server
- An Asyntai account on the Starter plan or higher

## License

Apache License 2.0. See [LICENSE](LICENSE).

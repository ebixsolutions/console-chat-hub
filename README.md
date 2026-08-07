# AI Chatbot

Build an AI customer service chatbot platform with a console dashboard 

and an embeddable chat widget.

Tech stack: React + TypeScript + Tailwind CSS + Supabase (already connected).

The database schema is already set up in Supabase with 17 tables including:

widget_config, channel_config, visitor_session, conversations, messages, 

agent_profile, ai_reply_draft, handoff_event, and more.

Create the basic app structure with:

- A login page at /login using Supabase Auth

- A console layout at /console with sidebar navigation

- A placeholder page at /console/widget-preview  

- A public sandbox page at /widget-sandbox.html for widget testing

- A public folder at /public/widget/ for chat.js

Do not create any database tables — they already exist.

Do not use mock data.

Just set up the routing, layout, auth, and basic page structure.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://console-chat-hub.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/4dbf593e-577e-4af4-a553-460441c34473).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

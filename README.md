# Extension-WebSearch

Add web search results to LLM prompts using Serper and function tool calling.

## Setup

### Serper

Requires an API key.

Get the key here: <https://serper.dev/>

#### What can be included in the search result?

1. Answer box.
2. Knowledge graph.
3. Page snippets.
4. Relevant questions.
5. Images.

## How to use

1. Make sure you use the latest version of SillyTavern (staging branch preferred).
2. Install the extension via the "Download Extensions & Assets" menu in SillyTavern.
3. Open the "Web Search" extension settings, set your Serper API key, and enable the extension.
4. The extension registers two [function tools](https://docs.sillytavern.app/for-contributors/function-calling/): **WebSearch** (search the web for a query) and **VisitLinks** (visit web links and extract page content). Must use a supported Chat Completion API with function calling enabled in the AI Response settings.
5. Optionally, configure the settings to your liking.

## Settings

### General

1. Enabled - toggles the extension on and off.
2. Serper Key - your Serper API key.
3. Cache Lifetime - how long (in seconds) the search results are cached for your prompt. Default = one week.

### Prompt Settings

1. Prompt Budget - sets the maximum capacity of the inserted text (in characters of text, NOT tokens). Rule of thumb: 1 token ~ 3-4 characters, adjust according to your model's context limits. Default = 2000 characters.
2. Insertion Template - how the result gets inserted into the prompt. Supports the usual macro + special macro: `{{query}}` for search query and `{{text}}` for search results.

### Page Scraping

1. Include Images - include relevant image URLs in the search results and function tool output. Depending on your SillyTavern setup, these may be attached to the chat automatically.
2. Visit Count - how many links will be visited and parsed for text. This also caps how many links the VisitLinks tool will fetch.
3. Visit Domain Blacklist - site domains to be excluded from visiting. One per line.
4. File Header - file header template, inserted at the start of the text file, has an additional `{{query}}` macro.
5. Block Header - link block template, inserted with the parsed content of every link. Use `{{link}}` macro for page URL and `{{text}}` for page content.

## Slash Command

This extension also provides a `/websearch` slash command to use in STscript. More info here: <https://docs.sillytavern.app/usage/st-script/>

```txt
/websearch (links=on|off snippets=on|off [query]) – performs a web search query. Use named arguments to specify what to return - page snippets (default: on) or full parsed pages (default: off) or both.

Example: /websearch links=off snippets=on how to make a sandwich
```
